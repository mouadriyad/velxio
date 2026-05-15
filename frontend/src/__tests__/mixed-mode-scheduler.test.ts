/**
 * Phase 1b continued — Step 1 tests for MixedModeScheduler.
 *
 * Exercises the subscriber routing and voltage cache in isolation from
 * the SPICE engine.  The engine is never booted in these tests; we
 * drive `publishVoltage` directly so the routing logic can be locked
 * down before the real `alter + tran + readVec` loop lands.
 *
 * Coverage:
 *   - publishVoltage fires every matching subscriber and only those
 *   - getCurrentVoltage returns the last published value per pin
 *   - unsubscribe removes the callback cleanly
 *   - reset (via __resetMixedModeScheduler) clears state between tests
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerEngineFactoryForTests,
  type NgSpiceClient,
} from '../simulation/spice/MixedModeScheduler';

afterEach(() => {
  __resetMixedModeScheduler();
});

/** Minimal in-memory NgSpiceClient — tracks calls and returns canned
 *  voltages for `readVec`. */
function fakeClient(opts: { voltages?: Record<string, number> } = {}): {
  client: NgSpiceClient;
  calls: { command: string[]; alter: Array<[string, number]>; loadedNetlist: string | null };
} {
  const voltages = opts.voltages ?? {};
  const calls = {
    command: [] as string[],
    alter: [] as Array<[string, number]>,
    loadedNetlist: null as string | null,
  };
  const client: NgSpiceClient = {
    async init() {},
    async loadNetlist(netlist) {
      calls.loadedNetlist = netlist;
    },
    async command(cmd) {
      calls.command.push(cmd);
      return { rc: 0, stdout: [], stderr: [] };
    },
    async alter(name, value) {
      calls.alter.push([name, value]);
      return undefined;
    },
    async readVec(name) {
      // Strip 'v(' / ')' to look up by net name.
      const match = name.match(/^v\((.+)\)$/i);
      const netName = match ? match[1] : name;
      const v = voltages[netName];
      if (v === undefined) {
        throw new Error(`unknown vec ${name}`);
      }
      return {
        name,
        real: new Float64Array([v]),
        imag: null,
        complex: false,
        unit: 'V',
      };
    },
    dispose() {},
  };
  return { client, calls };
}

describe('MixedModeScheduler — voltage cache', () => {
  it('returns null until something is published', () => {
    const sched = getMixedModeScheduler();
    expect(sched.getCurrentVoltage('q1', 'C')).toBeNull();
  });

  it('returns the last published voltage per (component, pin)', () => {
    const sched = getMixedModeScheduler();
    sched.publishVoltage('q1', 'C', 4.5);
    sched.publishVoltage('q1', 'B', 1.2);
    sched.publishVoltage('q2', 'C', 0.3);
    expect(sched.getCurrentVoltage('q1', 'C')).toBe(4.5);
    expect(sched.getCurrentVoltage('q1', 'B')).toBe(1.2);
    expect(sched.getCurrentVoltage('q2', 'C')).toBe(0.3);
    sched.publishVoltage('q1', 'C', 2.7); // overwrite
    expect(sched.getCurrentVoltage('q1', 'C')).toBe(2.7);
  });
});

describe('MixedModeScheduler — subscribe / publish routing', () => {
  it('fires the matching subscriber with the published voltage', () => {
    const sched = getMixedModeScheduler();
    const cb = vi.fn();
    sched.subscribe('q1', 'C', cb);
    sched.publishVoltage('q1', 'C', 4.7);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('UNKNOWN', 4.7);
  });

  it('does NOT fire subscribers watching a different pin', () => {
    const sched = getMixedModeScheduler();
    const cbMatching = vi.fn();
    const cbOtherPin = vi.fn();
    const cbOtherComp = vi.fn();
    sched.subscribe('q1', 'C', cbMatching);
    sched.subscribe('q1', 'B', cbOtherPin);
    sched.subscribe('q2', 'C', cbOtherComp);
    sched.publishVoltage('q1', 'C', 4.7);
    expect(cbMatching).toHaveBeenCalledTimes(1);
    expect(cbOtherPin).not.toHaveBeenCalled();
    expect(cbOtherComp).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers on the same pin (fan-out)', () => {
    const sched = getMixedModeScheduler();
    const cbA = vi.fn();
    const cbB = vi.fn();
    sched.subscribe('q1', 'C', cbA);
    sched.subscribe('q1', 'C', cbB);
    sched.publishVoltage('q1', 'C', 4.7);
    expect(cbA).toHaveBeenCalledWith('UNKNOWN', 4.7);
    expect(cbB).toHaveBeenCalledWith('UNKNOWN', 4.7);
  });

  it('unsubscribe handle detaches the callback', () => {
    const sched = getMixedModeScheduler();
    const cb = vi.fn();
    const cancel = sched.subscribe('q1', 'C', cb);
    sched.publishVoltage('q1', 'C', 4.7);
    expect(cb).toHaveBeenCalledTimes(1);
    cancel();
    sched.publishVoltage('q1', 'C', 0.3);
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it('reset clears subscribers and voltage cache', () => {
    const sched = getMixedModeScheduler();
    const cb = vi.fn();
    sched.subscribe('q1', 'C', cb);
    sched.publishVoltage('q1', 'C', 4.7);
    __resetMixedModeScheduler();

    const sched2 = getMixedModeScheduler();
    expect(sched2).not.toBe(sched);
    expect(sched2.getCurrentVoltage('q1', 'C')).toBeNull();
    sched2.publishVoltage('q1', 'C', 0.5);
    // The old subscriber attached to the disposed scheduler must NOT
    // fire from the new scheduler instance.
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('MixedModeScheduler — loadCircuit + resolveDc (Step 2)', () => {
  it('loadCircuit calls engine.loadNetlist exactly once with the supplied netlist', async () => {
    const { client, calls } = fakeClient();
    __setSchedulerEngineFactoryForTests(() => client);
    const sched = getMixedModeScheduler();

    const netlist = 'V1 1 0 DC 5\n.op\n.end\n';
    await sched.loadCircuit(netlist, new Map([['comp:p', '1']]));
    expect(calls.loadedNetlist).toBe(netlist);
  });

  it('resolveDc fires .op and publishes voltages for every pin in pinNetMap', async () => {
    const { client, calls } = fakeClient({
      voltages: { net_drain: 4.97, net_gate: 0.5 },
    });
    __setSchedulerEngineFactoryForTests(() => client);
    const sched = getMixedModeScheduler();

    await sched.loadCircuit(
      '* netlist',
      new Map([
        ['q1:D', 'net_drain'],
        ['q1:G', 'net_gate'],
        ['q1:S', '0'],
      ]),
    );

    const events: Array<{ id: string; pin: string; v: number }> = [];
    sched.subscribe('q1', 'D', (_state, v) => events.push({ id: 'q1', pin: 'D', v }));
    sched.subscribe('q1', 'G', (_state, v) => events.push({ id: 'q1', pin: 'G', v }));
    sched.subscribe('q1', 'S', (_state, v) => events.push({ id: 'q1', pin: 'S', v }));

    await sched.resolveDc();

    expect(calls.command).toContain('op');
    expect(sched.getCurrentVoltage('q1', 'D')).toBeCloseTo(4.97);
    expect(sched.getCurrentVoltage('q1', 'G')).toBeCloseTo(0.5);
    // Ground pins resolve to 0 without a readVec call (net '0' shortcut).
    expect(sched.getCurrentVoltage('q1', 'S')).toBe(0);
    // All three subscribers received their published voltage.
    expect(events).toEqual(
      expect.arrayContaining([
        { id: 'q1', pin: 'D', v: expect.closeTo(4.97, 2) },
        { id: 'q1', pin: 'G', v: expect.closeTo(0.5, 2) },
        { id: 'q1', pin: 'S', v: 0 },
      ]),
    );
  });

  it('resolveDc tolerates pins whose net is not in the analysis', async () => {
    const { client } = fakeClient({ voltages: { net_present: 3.3 } });
    __setSchedulerEngineFactoryForTests(() => client);
    const sched = getMixedModeScheduler();

    await sched.loadCircuit(
      '* netlist',
      new Map([
        ['comp:P', 'net_present'],
        ['comp:M', 'net_missing'],
      ]),
    );
    // Must not throw even though net_missing has no canned voltage.
    await sched.resolveDc();
    expect(sched.getCurrentVoltage('comp', 'P')).toBeCloseTo(3.3);
    expect(sched.getCurrentVoltage('comp', 'M')).toBeNull();
  });

  it('resolveDc without loadCircuit first throws a clear error', async () => {
    const sched = getMixedModeScheduler();
    await expect(sched.resolveDc()).rejects.toThrow(/loadCircuit first/i);
  });

  it('onMcuPinChange alters the matching V source and republishes voltages', async () => {
    let drainV = 4.9;
    let gateV = 0;
    const client: NgSpiceClient = {
      async init() {},
      async loadNetlist() {},
      async command(_cmd) {
        return { rc: 0, stdout: [], stderr: [] };
      },
      async alter(name, value) {
        // Simulate the analog response: the gate net follows the
        // arduino source, and the drain swings between high and low as
        // the gate crosses Vth.
        if (name === 'V_uno_9') {
          gateV = value;
          drainV = value >= 1.6 ? 0.05 : 4.9;
        }
        return undefined;
      },
      async readVec(name) {
        const m = name.match(/^v\((.+)\)$/i);
        const net = m ? m[1] : name;
        if (net === 'net_drain') return { name, real: new Float64Array([drainV]), imag: null, complex: false, unit: 'V' };
        if (net === 'net_gate') return { name, real: new Float64Array([gateV]), imag: null, complex: false, unit: 'V' };
        throw new Error('unknown net');
      },
      dispose() {},
    };
    __setSchedulerEngineFactoryForTests(() => client);
    const sched = getMixedModeScheduler();
    await sched.loadCircuit(
      '* netlist',
      new Map([
        ['q1:D', 'net_drain'],
        ['q1:G', 'net_gate'],
      ]),
    );
    await sched.resolveDc();
    expect(sched.getCurrentVoltage('q1', 'D')).toBeCloseTo(4.9);
    expect(sched.getCurrentVoltage('q1', 'G')).toBeCloseTo(0);

    // MCU drives pin 9 HIGH at 5V → gate follows, drain pulls down.
    await sched.onMcuPinChange('uno', '9', true, 5);
    expect(sched.getCurrentVoltage('q1', 'G')).toBeCloseTo(5);
    expect(sched.getCurrentVoltage('q1', 'D')).toBeCloseTo(0.05);

    // MCU drives pin 9 LOW → drain restores.
    await sched.onMcuPinChange('uno', '9', false, 5);
    expect(sched.getCurrentVoltage('q1', 'G')).toBeCloseTo(0);
    expect(sched.getCurrentVoltage('q1', 'D')).toBeCloseTo(4.9);
  });

  it('onMcuPinChange is a no-op when no engine has been started', async () => {
    const sched = getMixedModeScheduler();
    // No __setSchedulerEngineFactoryForTests; no loadCircuit. Must not throw.
    await expect(
      sched.onMcuPinChange('uno', '9', true, 5),
    ).resolves.toBeUndefined();
  });

  it('loadCircuit replaces the previous circuit and clears the voltage cache', async () => {
    const { client } = fakeClient({ voltages: { net_a: 1.1, net_b: 2.2 } });
    __setSchedulerEngineFactoryForTests(() => client);
    const sched = getMixedModeScheduler();

    await sched.loadCircuit('first', new Map([['x:p', 'net_a']]));
    await sched.resolveDc();
    expect(sched.getCurrentVoltage('x', 'p')).toBeCloseTo(1.1);

    await sched.loadCircuit('second', new Map([['y:q', 'net_b']]));
    // Cache for the old pin is gone immediately on reload.
    expect(sched.getCurrentVoltage('x', 'p')).toBeNull();
    await sched.resolveDc();
    expect(sched.getCurrentVoltage('y', 'q')).toBeCloseTo(2.2);
  });
});
