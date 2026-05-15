/**
 * MixedModeScheduler — orchestrates the digital ↔ SPICE coupling for
 * Phase 1b of the mixed-mode simulator project.
 *
 * Architecture in three layers:
 *
 *   ┌────────────────────────────┐
 *   │ MCU sim (AVR / RP2040 /    │  fires PinManager.onPinChange()
 *   │ ESP32 bridge)              │  events on every digitalWrite()
 *   └─────────────┬──────────────┘
 *                 │ pin edge
 *                 ▼
 *   ┌────────────────────────────┐
 *   │ MixedModeScheduler         │  batches edges, builds netlist via
 *   │   • alter V_pin sources    │  NetlistBuilder, drives ngspice via
 *   │   • short tran advance     │  NgSpiceInteractive
 *   │   • read v(node) for each  │
 *   │     component pin          │
 *   └─────────────┬──────────────┘
 *                 │ node voltage event
 *                 ▼
 *   ┌────────────────────────────┐
 *   │ SpiceResolvedPinResolver   │  threshold-converts v → HIGH/LOW,
 *   │                            │  fires component handler callback
 *   └────────────────────────────┘
 *
 * Phase 1a vendored NgSpiceInteractive and the WASM build.  This file is
 * the Phase 1b skeleton — the API and lifecycle are in place, but the
 * actual `alter + tran + readVec` loop is marked TODO because
 * (a) the WASM is single-threaded, so `bg_run` is not useful and we
 *     need the short-tran workaround, and
 * (b) the netlist build flow needs to be re-wired from the existing
 *     200 ms polling in `subscribeToStore.ts` to event-driven.
 *
 * For now, the scheduler exposes the API surface that component
 * handlers and DynamicComponent will use, plus a `start()` /
 * `stop()` lifecycle controlled by `useSimulatorStore.boards[*].running`.
 * When `start()` is called the scheduler logs "started" and components
 * subscribing to it get FLOATING resolutions — i.e. behavior
 * indistinguishable from "SPICE not available".  Phase 1b's next
 * sub-task replaces the stub data flow with real readVec calls.
 *
 * See:
 *   project/sim-mixedmode/phase-01-mixed-mode-coupling.md
 *   simulation/spice/wasm/NgSpiceInteractive.ts
 */

import { NgSpiceInteractive } from './wasm/NgSpiceInteractive';
import type { PinState, SpiceVoltageSource } from '../PinResolver';

/**
 * The subset of NgSpiceInteractive the scheduler depends on.  Spelled
 * out as an interface so unit tests can inject a mock without booting
 * the WASM worker.
 */
export interface NgSpiceClient {
  init(): Promise<void>;
  loadNetlist(netlist: string): Promise<void>;
  command(cmd: string): Promise<{ rc: number; stdout: string[]; stderr: string[] }>;
  alter(sourceName: string, dcValue: number): Promise<unknown>;
  readVec(name: string): Promise<{
    name: string;
    real: Float64Array;
    imag: Float64Array | null;
    complex: boolean;
    unit: string;
  }>;
  dispose(): void;
}

/**
 * Identity of a "pin of interest" — a place a SpiceResolvedPinResolver
 * is watching for voltage changes.  The (boardId, pinName) → SPICE-net
 * mapping is built lazily as components register.
 */
export interface NodeSubscription {
  componentId: string;
  componentPinName: string;
  cb: (state: PinState, voltage: number) => void;
}

type SubscriptionToken = number;

/**
 * Singleton-style scheduler.  Multiple components use the same SPICE
 * engine instance; there's no value in running parallel solvers.
 *
 * Phase 1b: the scheduler holds the engine + the subscription registry
 * but does NOT yet drive real SPICE solves on pin edges.  Phase 1b
 * continued: implement the alter+tran+readVec loop, hook NetlistBuilder.
 */
/** Voltage cache key = `${componentId}|${componentPinName}`. */
function pinKey(componentId: string, componentPinName: string): string {
  return `${componentId}|${componentPinName}`;
}

class MixedModeSchedulerImpl implements SpiceVoltageSource {
  private engine: NgSpiceClient | null = null;
  private engineFactory: () => NgSpiceClient = () => new NgSpiceInteractive();
  private nextToken: SubscriptionToken = 1;
  private subscriptions = new Map<SubscriptionToken, NodeSubscription>();
  private voltages = new Map<string, number>();
  /** `${componentId}:${pinName}` → SPICE net name (from NetlistBuilder). */
  private pinNetMap = new Map<string, string>();
  private running = false;
  private initPromise: Promise<void> | null = null;

  /** True while the scheduler is actively driving the SPICE engine. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the scheduler.  Lazy-loads the WASM engine on first call.  No-op
   * if already running.  Called from `useSimulatorStore` when any board
   * transitions to running.
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.engine) {
      this.engine = this.engineFactory();
    }
    if (!this.initPromise) {
      this.initPromise = this.engine.init();
    }
    await this.initPromise;
    this.running = true;
  }

  /**
   * Load a SPICE netlist plus the (component, pin) → SPICE-net mapping
   * produced by `NetlistBuilder.buildNetlist`.  Replaces any previously
   * loaded circuit.  Subsequent `resolveDc` / `alter` / `onMcuPinChange`
   * calls operate on this circuit.
   *
   * Idempotent in the sense that calling it again with a fresh circuit
   * simply re-loads — the engine is kept warm.  Pin-net mapping keys
   * use the NetlistBuilder convention `${componentId}:${pinName}`.
   */
  async loadCircuit(netlist: string, pinNetMap: Map<string, string>): Promise<void> {
    if (!this.engine) {
      this.engine = this.engineFactory();
    }
    if (!this.initPromise) {
      this.initPromise = this.engine.init();
    }
    await this.initPromise;
    await this.engine.loadNetlist(netlist);
    this.pinNetMap = new Map(pinNetMap);
    // Voltages cache is now stale — clear it.  resolveDc() will repopulate.
    this.voltages.clear();
  }

  /**
   * Run a DC operating-point solve and publish the resolved voltage for
   * every (component, pin) currently in the pinNetMap.  Subscribers
   * fire as voltages land in the cache.  Ground pins (canonical net
   * `0`) are published as 0 V without a readVec round-trip.
   */
  async resolveDc(): Promise<void> {
    if (!this.engine) {
      throw new Error('MixedModeScheduler.resolveDc(): call loadCircuit first');
    }
    await this.engine.command('op');
    for (const [key, net] of this.pinNetMap) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      const componentId = key.slice(0, idx);
      const pinName = key.slice(idx + 1);
      if (net === '0') {
        this.publishVoltage(componentId, pinName, 0);
        continue;
      }
      try {
        const vec = await this.engine.readVec(`v(${net})`);
        const v = vec.real[0] ?? 0;
        this.publishVoltage(componentId, pinName, v);
      } catch {
        // Net wasn't part of this analysis — skip silently so a single
        // disconnected component pin doesn't break the whole resolve.
      }
    }
  }

  /**
   * Stop the scheduler.  Components stay subscribed but stop receiving
   * SPICE-resolved events until the next start().
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    // TODO Phase 1b — pause the SPICE driver loop.  Engine instance is
    // intentionally kept warm so restart is cheap; dispose only on
    // unmount or shutdown.
  }

  /**
   * Tear down the engine entirely.  Used on app unmount; in normal flow
   * we just stop() + start() to avoid re-paying the ~2-5 s WASM init
   * cost.
   */
  dispose(): void {
    this.running = false;
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
    this.initPromise = null;
    this.subscriptions.clear();
    this.voltages.clear();
    this.pinNetMap.clear();
  }

  /**
   * Register a component pin to receive SPICE-resolved voltage events.
   * Implements the SpiceVoltageSource contract used by
   * `createSpiceResolvedPinResolver`.  Returns an unsubscribe handle.
   *
   * Phase 1b: stub — no events ever fire.  The caller's resolver will
   * report whatever its fallback state is (typically FLOATING) and
   * never transition.  Phase 1b continued: actually emit events when
   * SPICE solves complete.
   */
  subscribe(
    componentId: string,
    componentPinName: string,
    cb: (state: PinState, voltage: number) => void,
  ): () => void {
    const token = this.nextToken++;
    this.subscriptions.set(token, { componentId, componentPinName, cb });
    return () => {
      this.subscriptions.delete(token);
    };
  }

  /**
   * Look up the latest known voltage on a component pin's SPICE net.
   * Returns the value last published via `publishVoltage`, or null if
   * nothing has been published for that pin yet.  Phase 1b continued
   * will populate this cache from `NgSpiceInteractive.readVec` after
   * each solve.
   */
  getCurrentVoltage(componentId: string, componentPinName: string): number | null {
    const v = this.voltages.get(pinKey(componentId, componentPinName));
    return v === undefined ? null : v;
  }

  /**
   * Publish a freshly-resolved voltage for a (component, pin) and
   * notify all subscribers watching that key.  Stores the value in
   * the cache so subsequent `getCurrentVoltage` calls see it.
   *
   * The SPICE-resolved PinResolver does its own threshold conversion,
   * so this layer only forwards raw volts with a placeholder
   * `'UNKNOWN'` state — the resolver re-derives HIGH/LOW from the
   * voltage using its configured thresholds.  Skipping the threshold
   * decision here keeps the scheduler I/O-family-agnostic.
   */
  publishVoltage(componentId: string, componentPinName: string, voltage: number): void {
    this.voltages.set(pinKey(componentId, componentPinName), voltage);
    for (const sub of this.subscriptions.values()) {
      if (sub.componentId === componentId && sub.componentPinName === componentPinName) {
        // 'UNKNOWN' is a sentinel — the SpiceResolvedPinResolver re-
        // computes the state from the voltage via its threshold
        // configuration.  We could pass any string here; 'UNKNOWN' is
        // the convention used in the Phase 1b unit tests.
        sub.cb('UNKNOWN' as PinState, voltage);
      }
    }
  }

  /**
   * Notify the scheduler that an MCU pin changed state.  Issues an
   * `alter V_<board>_<pin> dc <voltage>` to ngspice, re-runs the DC
   * operating point, and refreshes the voltage cache + subscribers for
   * every (component, pin) in the current pinNetMap.
   *
   * Caller is responsible for converting the digital state to a
   * voltage: typically `state ? vcc : 0`, but a board with output
   * impedance or open-drain semantics may use a different mapping.
   *
   * Returns a promise that resolves after the resulting `resolveDc`
   * completes.  When `start()` hasn't been called yet (no engine), the
   * call is a silent no-op so legacy code paths that fire this
   * unconditionally don't crash.
   */
  async onMcuPinChange(
    boardId: string,
    pinName: string,
    state: boolean,
    vcc: number,
  ): Promise<void> {
    if (!this.engine) return;
    const sourceName = `V_${boardId}_${pinName}`;
    const voltage = state ? vcc : 0;
    await this.engine.alter(sourceName, voltage);
    await this.resolveDc();
  }
}

/** The one and only scheduler.  Lazily constructed. */
let instance: MixedModeSchedulerImpl | null = null;

export function getMixedModeScheduler(): MixedModeSchedulerImpl {
  if (!instance) instance = new MixedModeSchedulerImpl();
  return instance;
}

/** Test helper — drops the singleton so test runs don't pollute each
 *  other. NEVER call from production code. */
export function __resetMixedModeScheduler(): void {
  if (instance) instance.dispose();
  instance = null;
}

/** Test helper — inject a fake NgSpiceClient so `loadCircuit` /
 *  `resolveDc` can be exercised without a real WASM worker. The factory
 *  is invoked the next time the scheduler instantiates its engine.
 *  Must be called BEFORE `start()` / `loadCircuit()`. */
export function __setSchedulerEngineFactoryForTests(
  factory: () => NgSpiceClient,
): void {
  const sched = getMixedModeScheduler() as unknown as {
    engineFactory: () => NgSpiceClient;
  };
  sched.engineFactory = factory;
}

export type MixedModeScheduler = MixedModeSchedulerImpl;
