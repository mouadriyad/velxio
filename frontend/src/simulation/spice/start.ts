/**
 * start.ts — production wiring for the mixed-mode simulator.
 *
 * The single function `startSimulation()` mounts everything the
 * editor needs to run circuits end-to-end against the WASM ngspice:
 *
 *   1. CircuitSimulationService — orchestrates solves, publishes to
 *      useElectricalStore.
 *   2. connectAnalogInputsToMcu — subscribes to useElectricalStore
 *      and pushes voltages into MCU ADCs.
 *   3. connectMcuEdgesToService — MCU pin transitions trigger
 *      scheduler.alterSource + republish via the service.
 *
 * Replaces the old EditorPage useEffect that chained the legacy
 * wireElectricalSolver + connectLegacySolverToMixedMode +
 * connectMixedModeSchedulerToStore + connectAnalogInputsToMcu.
 *
 * Phase 1c step G1 of the mixed-mode migration.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import {
  getMixedModeScheduler,
} from './MixedModeScheduler';
import {
  CircuitSimulationService,
  type SimulatorStorePort,
  type ElectricalStorePort,
  type MixedModeSchedulerPort,
  type ElectricalSnapshot,
} from './CircuitSimulationService';
import { connectAnalogInputsToMcu } from './connectAnalogInputsToMcu';
import { connectMcuEdgesToService } from './connectMcuEdgesToService';
import { collectPinStates } from './collectPinStates';

/** Adapt useElectricalStore to the ElectricalStorePort. */
function createElectricalStorePort(): ElectricalStorePort {
  return {
    publish(snapshot: ElectricalSnapshot): void {
      useElectricalStore.getState().setSolveResult({
        nodeVoltages: snapshot.nodeVoltages,
        branchCurrents: snapshot.branchCurrents,
        pinNetMap: snapshot.pinNetMap,
        analysisMode: snapshot.analysisMode,
        timeWaveforms: snapshot.timeWaveforms,
        converged: snapshot.warnings.length === 0,
        error: snapshot.warnings[0] ?? null,
        lastSolveMs: 0,
        submittedNetlist: '',
      });
    },
  };
}

/**
 * Mount the simulation loop.  Returns an unsubscribe handle for
 * editor cleanup.
 */
export function startSimulation(): () => void {
  const service = new CircuitSimulationService(
    useSimulatorStore as unknown as SimulatorStorePort,
    createElectricalStorePort(),
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    {
      collectBoardPinStates: (boardId, boardKind, wires) =>
        collectPinStates(
          boardId,
          boardKind as Parameters<typeof collectPinStates>[1],
          wires as Parameters<typeof collectPinStates>[2],
        ),
    },
  );
  // Phase 1d #3 — pre-boot the WASM engine the moment the editor
  // mounts.  Without this, the first solve (typically the user's
  // first canvas edit) pays the full WASM init cost (~2-5 s) and the
  // canvas appears frozen.  By kicking init now, the Worker boots
  // while the user looks at the empty canvas; by the time they wire
  // anything, the engine is warm.
  void getMixedModeScheduler().start();

  const unsubService = service.start();
  const unsubAdc = connectAnalogInputsToMcu();
  const unsubEdges = connectMcuEdgesToService(service);
  return () => {
    unsubService();
    unsubAdc();
    unsubEdges();
  };
}
