import { QuickJS } from 'quickjs-wasi';
import type { WorkerConfiguration } from './protocol';
import {
  type DeliveryEntry,
  INTERPRETER_ABI_VERSION,
  type InterpreterCheckpoint,
  QUICKJS_WASI_VERSION,
  type ResolverEntry,
  type WorkflowOperation,
} from './types';

export class CheckpointLimitError extends Error {
  override readonly name = 'CheckpointLimitError';
}

type CheckpointState = {
  readonly vm: QuickJS;
  readonly configuration: WorkerConfiguration;
  readonly wasmDigest: string;
  readonly configurationDigest: string;
  readonly sourceDigest: string;
  readonly nextCallSequence: number;
  readonly pendingOperations: ReadonlyMap<string, WorkflowOperation>;
  readonly deliveries: ReadonlyMap<string, DeliveryEntry>;
};

export function createCheckpoint(
  state: CheckpointState,
): InterpreterCheckpoint {
  const pendingOperations = [...state.pendingOperations.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const resolverMap: ResolverEntry[] = pendingOperations.map((operation) => ({
    operationId: operation.id,
    kind: operation.kind,
    name: operation.name,
  }));
  const vmSnapshot = QuickJS.serializeSnapshot(state.vm.snapshot());
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify({
      pendingOperations,
      resolverMap,
      deliveries: [...state.deliveries.values()],
    }),
  ).byteLength;
  if (
    vmSnapshot.byteLength + metadataBytes >
    state.configuration.limits.checkpointBytes
  ) {
    throw new CheckpointLimitError(
      `serialized checkpoint exceeds ${state.configuration.limits.checkpointBytes} bytes`,
    );
  }
  return {
    formatVersion: 1,
    bridgeAbiVersion: INTERPRETER_ABI_VERSION,
    quickjsWasiVersion: QUICKJS_WASI_VERSION,
    wasmDigest: state.wasmDigest,
    configurationDigest: state.configurationDigest,
    sourceDigest: state.sourceDigest,
    identity: state.configuration.identity,
    vmSnapshot,
    pendingOperations,
    resolverMap,
    deliveryMap: [...state.deliveries.values()].sort(
      (left, right) => left.order - right.order,
    ),
    nextCallSequence: state.nextCallSequence,
  };
}

export function restoreCheckpointMetadata(
  checkpoint: InterpreterCheckpoint,
  pendingOperations: Map<string, WorkflowOperation>,
  deliveries: Map<string, DeliveryEntry>,
): number {
  for (const operation of checkpoint.pendingOperations) {
    pendingOperations.set(operation.id, operation);
  }
  let nextDeliveryOrder = 0;
  for (const delivery of checkpoint.deliveryMap) {
    deliveries.set(delivery.operationId, delivery);
    nextDeliveryOrder = Math.max(nextDeliveryOrder, delivery.order + 1);
  }
  return nextDeliveryOrder;
}
