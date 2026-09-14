import {
  type JournaledEffect,
  type JournaledEffects,
  PersistedCheckpointMetadataSchema,
  readGuestCompletion,
  readJournaledEffects,
} from './effects';
import type {
  InterpreterCheckpoint,
  InterpreterResult,
  WorkflowInterpreter,
  WorkflowOperation,
} from './interpreter';
import { restoreWorkflowInterpreter } from './interpreter';

export type ExternalEffectObservation =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'live';
      readonly externalId: string;
      readonly stage: 'admitted' | 'prompted';
      readonly writerEpoch: number;
    }
  | {
      readonly kind: 'terminal';
      readonly externalId: string;
      readonly result: unknown;
      readonly writerEpoch: number;
    };

export interface RecoveryEffectPort {
  inspect(effect: JournaledEffect): Promise<ExternalEffectObservation>;
  quarantine(effect: JournaledEffect, reason: string): Promise<void>;
  stop(effect: JournaledEffect, reason: string): Promise<'stopped'>;
}

export type RecoveryAction =
  | { readonly kind: 'dispatch'; readonly operationId: string }
  | {
      readonly kind: 'uncertain';
      readonly operationId: string;
      readonly stopped: boolean;
    };

export type RecoveredWorkflowRun =
  | {
      readonly kind: 'suspended';
      readonly interpreter: WorkflowInterpreter;
      readonly actions: readonly RecoveryAction[];
      readonly reusedOperationIds: readonly string[];
    }
  | {
      readonly kind: 'completed';
      readonly value: unknown;
      readonly actions: readonly RecoveryAction[];
      readonly reusedOperationIds: readonly string[];
    };

export class RecoveryError extends Error {
  override readonly name = 'RecoveryError';

  constructor(
    readonly code:
      | 'missing_checkpoint'
      | 'corrupt_checkpoint'
      | 'incompatible_checkpoint',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export async function recoverWorkflowRun(input: {
  readonly effects: JournaledEffects;
  readonly port: RecoveryEffectPort;
  readonly dispatch: (operation: WorkflowOperation) => Promise<void>;
}): Promise<RecoveredWorkflowRun> {
  const snapshot = input.effects.snapshot();
  const runId = input.effects.runId;
  const storedCheckpoint = snapshot.checkpoints.find(
    (checkpoint) => checkpoint.runId === runId,
  );
  if (storedCheckpoint === undefined) {
    throw new RecoveryError(
      'missing_checkpoint',
      `workflow run ${runId} has no durable checkpoint`,
    );
  }
  const metadataResult = PersistedCheckpointMetadataSchema.safeParse(
    storedCheckpoint.metadata,
  );
  if (!metadataResult.success) {
    throw new RecoveryError(
      'corrupt_checkpoint',
      `workflow run ${runId} has corrupt checkpoint metadata`,
      { cause: metadataResult.error },
    );
  }
  const metadata = metadataResult.data;
  validateCheckpointEnvelope({
    metadata,
    runId,
    journalCursor: storedCheckpoint.journalCursor,
    deliveryCursor: storedCheckpoint.deliveryCursor,
    maximumEventSequence: snapshot.events.reduce(
      (maximum, event) => Math.max(maximum, event.sequence),
      0,
    ),
    leaseEpoch: input.effects.lease.epoch,
  });
  const effects = readJournaledEffects(snapshot, runId);
  validateCheckpointEffects(metadata.operationIds, effects);

  const completion = readGuestCompletion(snapshot, runId);
  if (completion !== undefined) {
    return {
      kind: 'completed',
      value: completion.value,
      actions: [],
      reusedOperationIds: [completion.operationId],
    };
  }

  const interpreter = await restoreCheckpoint(
    {
      formatVersion: metadata.formatVersion,
      bridgeAbiVersion: metadata.bridgeAbiVersion,
      quickjsWasiVersion: metadata.quickjsWasiVersion,
      wasmDigest: metadata.wasmDigest,
      configurationDigest: metadata.configurationDigest,
      sourceDigest: metadata.sourceDigest,
      identity: metadata.identity,
      vmSnapshot: storedCheckpoint.snapshot,
      pendingOperations: metadata.pendingOperations,
      resolverMap: metadata.resolverMap,
      deliveryMap: metadata.deliveryMap,
      nextCallSequence: metadata.nextCallSequence,
    },
    input.effects,
    input.dispatch,
  );
  const actions: RecoveryAction[] = [];
  const missingEffects: JournaledEffect[] = [];

  try {
    for (const effect of effects) {
      if (effect.state === 'terminal') continue;
      if (effect.state === 'uncertain') {
        actions.push(await quarantineEffect(effect, input.port));
        continue;
      }
      const observation = await input.port.inspect(effect);
      if (observation.kind === 'missing') {
        missingEffects.push(effect);
        continue;
      }
      if (
        observation.kind === 'live' ||
        observation.writerEpoch !== input.effects.lease.epoch
      ) {
        input.effects.markUncertain(
          effect.operation.id,
          `external effect is ${observation.kind} in writer epoch ${observation.writerEpoch}`,
        );
        actions.push(await quarantineEffect(effect, input.port));
        continue;
      }
      await adoptTerminalObservation(effect, observation, input.effects);
    }

    for (const effect of missingEffects) {
      await input.dispatch(effect.operation);
      actions.push({ kind: 'dispatch', operationId: effect.operation.id });
    }

    const durableEffects = readJournaledEffects(
      input.effects.snapshot(),
      runId,
    );
    const reusedOperationIds: string[] = [];
    let result: InterpreterResult | undefined;
    for (const effect of durableEffects) {
      if (effect.state !== 'terminal' || effect.resultDelivered) continue;
      if (!metadata.operationIds.includes(effect.operation.id)) {
        throw new RecoveryError(
          'corrupt_checkpoint',
          `terminal result ${effect.operation.id} has no checkpoint resolver`,
        );
      }
      result = await interpreter.deliver(effect.operation.id, effect.result);
      reusedOperationIds.push(effect.operation.id);
    }

    if (result?.kind === 'completed') {
      const operationId = reusedOperationIds.at(-1);
      if (operationId === undefined) {
        throw new RecoveryError(
          'corrupt_checkpoint',
          `completed workflow run ${runId} has no reused result`,
        );
      }
      input.effects.acknowledgeGuestCompletion(operationId, result.value);
      await interpreter.dispose();
      return {
        kind: 'completed',
        value: result.value,
        actions,
        reusedOperationIds,
      };
    }
    return {
      kind: 'suspended',
      interpreter,
      actions,
      reusedOperationIds,
    };
  } catch (error) {
    await interpreter.dispose();
    throw error;
  }
}

async function adoptTerminalObservation(
  effect: JournaledEffect,
  observation: Extract<
    ExternalEffectObservation,
    { readonly kind: 'terminal' }
  >,
  effects: JournaledEffects,
): Promise<void> {
  if (effect.state === 'intent') {
    effects.acknowledgeAdmitted(effect.operation.id, observation.externalId);
    effects.acknowledgePrompted(effect.operation.id);
  } else if (effect.state === 'admitted') {
    effects.acknowledgePrompted(effect.operation.id);
  }
  await effects.commitResult(
    effect.operation.id,
    observation.result,
    effects.lease.epoch,
  );
}

async function quarantineEffect(
  effect: JournaledEffect,
  port: RecoveryEffectPort,
): Promise<RecoveryAction> {
  const reason = 'external mutation cannot be safely replayed';
  await port.quarantine(effect, reason);
  const stopped = (await port.stop(effect, reason)) === 'stopped';
  return { kind: 'uncertain', operationId: effect.operation.id, stopped };
}

function validateCheckpointEnvelope(input: {
  readonly metadata: ReturnType<typeof PersistedCheckpointMetadataSchema.parse>;
  readonly runId: string;
  readonly journalCursor: number;
  readonly deliveryCursor: number;
  readonly maximumEventSequence: number;
  readonly leaseEpoch: number;
}): void {
  const operationIds = input.metadata.pendingOperations.map(
    (operation) => operation.id,
  );
  const resolverIds = input.metadata.resolverMap.map(
    (resolver) => resolver.operationId,
  );
  const deliveryOrders = input.metadata.deliveryMap
    .map((delivery) => delivery.order)
    .sort((left, right) => left - right);
  const corrupt =
    input.metadata.identity.runId !== input.runId ||
    input.metadata.journalCursor !== input.journalCursor ||
    input.metadata.deliveryCursor !== input.deliveryCursor ||
    input.journalCursor > input.maximumEventSequence ||
    input.metadata.writerEpoch > input.leaseEpoch ||
    !sameStrings(input.metadata.operationIds, operationIds) ||
    !sameStrings(operationIds, resolverIds) ||
    deliveryOrders.some((order, index) => order !== index) ||
    input.deliveryCursor !== deliveryOrders.length;
  if (corrupt) {
    throw new RecoveryError(
      'corrupt_checkpoint',
      `workflow run ${input.runId} has an inconsistent checkpoint envelope`,
    );
  }
}

function validateCheckpointEffects(
  operationIds: readonly string[],
  effects: readonly JournaledEffect[],
): void {
  if (
    !sameStrings(
      operationIds,
      effects.map((effect) => effect.operation.id),
    )
  ) {
    throw new RecoveryError(
      'corrupt_checkpoint',
      'checkpoint operations do not match durable effects',
    );
  }
}

async function restoreCheckpoint(
  checkpoint: InterpreterCheckpoint,
  effects: JournaledEffects,
  dispatch: (operation: WorkflowOperation) => Promise<void>,
): Promise<WorkflowInterpreter> {
  try {
    return await restoreWorkflowInterpreter(checkpoint, {
      coordinator: effects,
      dispatch,
    });
  } catch (error) {
    throw new RecoveryError(
      'incompatible_checkpoint',
      'workflow interpreter checkpoint could not be restored',
      { cause: error },
    );
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
