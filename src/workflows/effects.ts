import { z } from 'zod';
import type {
  CheckpointCoordinator,
  InterpreterCheckpoint,
  WorkflowOperation,
} from './interpreter';
import type { JournalLease, JournalSnapshot, WorkflowJournal } from './journal';

const OperationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['task', 'tool', 'callback']),
    name: z.string(),
    input: z.unknown(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

const EffectRecordSchema = z
  .object({
    recordType: z.literal('workflow-effect'),
    runId: z.string().min(1),
    operation: OperationSchema,
    writerEpoch: z.number().int().positive(),
  })
  .strict();

const EffectResultSchema = z
  .object({
    recordType: z.literal('workflow-effect-result'),
    value: z.unknown(),
  })
  .strict();

const EffectEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      recordType: z.literal('workflow-effect-event'),
      kind: z.literal('transition'),
      runId: z.string().min(1),
      operationId: z.string().min(1),
      state: z.enum([
        'intent',
        'admitted',
        'prompted',
        'terminal',
        'uncertain',
      ]),
      externalId: z.string().min(1).optional(),
      reason: z.string().min(1).optional(),
      writerEpoch: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      recordType: z.literal('workflow-effect-event'),
      kind: z.literal('mutation'),
      runId: z.string().min(1),
      operationId: z.string().min(1),
      stage: z.enum(['create', 'prompt']),
      writerEpoch: z.number().int().positive(),
    })
    .strict(),
]);

const GuestEventSchema = z
  .object({
    recordType: z.literal('workflow-guest-event'),
    kind: z.literal('guest-completed'),
    runId: z.string().min(1),
    operationId: z.string().min(1),
    value: z.unknown(),
    writerEpoch: z.number().int().positive(),
  })
  .strict();

const ResolverSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(['task', 'tool', 'callback']),
    name: z.string(),
  })
  .strict();

const DeliverySchema = z
  .object({
    operationId: z.string().min(1),
    order: z.number().int().nonnegative(),
  })
  .strict();

export const PersistedCheckpointMetadataSchema = z
  .object({
    recordType: z.literal('workflow-checkpoint'),
    formatVersion: z.literal(1),
    bridgeAbiVersion: z.number().int().positive(),
    quickjsWasiVersion: z.string().min(1),
    wasmDigest: z.string().min(1),
    configurationDigest: z.string().min(1),
    sourceDigest: z.string().min(1),
    identity: z
      .object({
        runId: z.string().min(1),
        nodeId: z.string().min(1),
        attempt: z.number().int().nonnegative(),
      })
      .strict(),
    pendingOperations: z.array(OperationSchema),
    resolverMap: z.array(ResolverSchema),
    deliveryMap: z.array(DeliverySchema),
    nextCallSequence: z.number().int().nonnegative(),
    operationIds: z.array(z.string().min(1)),
    journalCursor: z.number().int().nonnegative(),
    deliveryCursor: z.number().int().nonnegative(),
    writerEpoch: z.number().int().positive(),
  })
  .strict();

export type EffectState =
  | 'intent'
  | 'admitted'
  | 'prompted'
  | 'terminal'
  | 'uncertain';

export type JournaledEffect = {
  readonly runId: string;
  readonly operation: WorkflowOperation;
  readonly writerEpoch: number;
  readonly state: EffectState;
  readonly mutationStage?: 'create' | 'prompt';
  readonly externalId?: string;
  readonly result: unknown | null;
  readonly resultDelivered: boolean;
};

export type GuestCompletion = {
  readonly operationId: string;
  readonly value: unknown;
};

export class EffectProtocolError extends Error {
  override readonly name = 'EffectProtocolError';

  constructor(
    readonly code:
      | 'corrupt_effect'
      | 'invalid_transition'
      | 'unknown_operation',
    message: string,
  ) {
    super(message);
  }
}

export class StaleEffectEpochError extends Error {
  override readonly name = 'StaleEffectEpochError';

  constructor(
    readonly operationId: string,
    readonly writerEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `effect ${operationId} belongs to lease epoch ${writerEpoch}, current epoch is ${currentEpoch}`,
    );
  }
}

export class JournaledEffects implements CheckpointCoordinator {
  readonly lease: JournalLease;
  readonly runId: string;
  private readonly journal: WorkflowJournal;

  constructor(input: {
    readonly journal: WorkflowJournal;
    readonly lease: JournalLease;
    readonly runId: string;
  }) {
    this.journal = input.journal;
    this.lease = input.lease;
    this.runId = input.runId;
  }

  async acknowledgeCheckpoint(
    checkpoint: InterpreterCheckpoint,
  ): Promise<void> {
    if (checkpoint.identity.runId !== this.runId) {
      throw new EffectProtocolError(
        'corrupt_effect',
        `checkpoint run ${checkpoint.identity.runId} does not match ${this.runId}`,
      );
    }
    const snapshot = this.snapshot();
    const existing = readJournaledEffects(snapshot, this.runId);
    let journalCursor = snapshot.events.reduce(
      (maximum, event) => Math.max(maximum, event.sequence),
      0,
    );
    const deliveryCursor = contiguousDeliveryCursor(checkpoint);
    this.journal.transaction(this.lease, (transaction) => {
      for (const operation of checkpoint.pendingOperations) {
        const current = existing.find(
          (effect) => effect.operation.id === operation.id,
        );
        if (current !== undefined) {
          assertSameOperation(current.operation, operation);
          continue;
        }
        const inserted = transaction.persistEffect(operation.id, {
          recordType: 'workflow-effect',
          runId: this.runId,
          operation,
          writerEpoch: this.lease.epoch,
        });
        if (!inserted) {
          throw new EffectProtocolError(
            'corrupt_effect',
            `operation ${operation.id} conflicts with another journal effect`,
          );
        }
        journalCursor = transaction.appendEvent(`${operation.id}:intent`, {
          recordType: 'workflow-effect-event',
          kind: 'transition',
          runId: this.runId,
          operationId: operation.id,
          state: 'intent',
          writerEpoch: this.lease.epoch,
        });
      }
      for (const delivery of checkpoint.deliveryMap) {
        const resultEntry = snapshot.outbox.find(
          (entry) =>
            entry.operationId === delivery.operationId &&
            entry.kind === 'result' &&
            entry.status === 'pending',
        );
        if (resultEntry !== undefined) {
          transaction.markDelivered(delivery.operationId, 'result');
        }
      }
      transaction.persistCheckpoint({
        runId: this.runId,
        snapshot: checkpoint.vmSnapshot,
        journalCursor,
        deliveryCursor,
        metadata: checkpointMetadata(
          checkpoint,
          journalCursor,
          deliveryCursor,
          this.lease.epoch,
        ),
      });
    });
  }

  beginMutation(operationId: string, stage: 'create' | 'prompt'): boolean {
    const effect = this.requireEffect(operationId);
    if (isFinal(effect.state)) return false;
    const expected = stage === 'create' ? 'intent' : 'admitted';
    if (effect.state !== expected) {
      throw new EffectProtocolError(
        'invalid_transition',
        `${stage} mutation requires ${expected}, found ${effect.state}`,
      );
    }
    if (effect.mutationStage === stage) return false;
    this.appendEvent(`${operationId}:mutation:${stage}`, {
      recordType: 'workflow-effect-event',
      kind: 'mutation',
      runId: this.runId,
      operationId,
      stage,
      writerEpoch: this.lease.epoch,
    });
    return true;
  }

  acknowledgeAdmitted(operationId: string, externalId: string): boolean {
    return this.transition(operationId, 'admitted', { externalId });
  }

  acknowledgePrompted(operationId: string): boolean {
    return this.transition(operationId, 'prompted');
  }

  async commitResult(
    operationId: string,
    result: unknown,
    writerEpoch: number,
  ): Promise<boolean> {
    if (writerEpoch !== this.lease.epoch) {
      throw new StaleEffectEpochError(
        operationId,
        writerEpoch,
        this.lease.epoch,
      );
    }
    const effect = this.requireEffect(operationId);
    if (isFinal(effect.state)) return false;
    if (effect.state !== 'prompted') {
      throw new EffectProtocolError(
        'invalid_transition',
        `terminal result requires prompted, found ${effect.state}`,
      );
    }
    this.journal.transaction(this.lease, (transaction) => {
      transaction.appendEvent(`${operationId}:terminal`, {
        recordType: 'workflow-effect-event',
        kind: 'transition',
        runId: this.runId,
        operationId,
        state: 'terminal',
        writerEpoch: this.lease.epoch,
      });
      transaction.persistResult(operationId, {
        recordType: 'workflow-effect-result',
        value: result,
      });
      transaction.markDelivered(operationId, 'effect');
    });
    return true;
  }

  markUncertain(operationId: string, reason: string): boolean {
    return this.transition(operationId, 'uncertain', { reason });
  }

  acknowledgeGuestCompletion(operationId: string, value: unknown): boolean {
    if (readGuestCompletion(this.snapshot(), this.runId) !== undefined) {
      return false;
    }
    this.journal.transaction(this.lease, (transaction) => {
      transaction.appendEvent(`${this.runId}:guest-completed`, {
        recordType: 'workflow-guest-event',
        kind: 'guest-completed',
        runId: this.runId,
        operationId,
        value,
        writerEpoch: this.lease.epoch,
      });
      transaction.markDelivered(operationId, 'result');
    });
    return true;
  }

  snapshot(): JournalSnapshot {
    return this.journal.recover(this.lease.projectId);
  }

  private requireEffect(operationId: string): JournaledEffect {
    const effect = readJournaledEffects(this.snapshot(), this.runId).find(
      (candidate) => candidate.operation.id === operationId,
    );
    if (effect === undefined) {
      throw new EffectProtocolError(
        'unknown_operation',
        `operation ${operationId} is not journaled`,
      );
    }
    return effect;
  }

  private transition(
    operationId: string,
    state: Exclude<EffectState, 'intent' | 'terminal'>,
    detail: { readonly externalId?: string; readonly reason?: string } = {},
  ): boolean {
    const effect = this.requireEffect(operationId);
    if (isFinal(effect.state) || effect.state === state) return false;
    if (!transitionAllowed(effect.state, state)) {
      throw new EffectProtocolError(
        'invalid_transition',
        `cannot transition ${operationId} from ${effect.state} to ${state}`,
      );
    }
    this.appendEvent(`${operationId}:${state}`, {
      recordType: 'workflow-effect-event',
      kind: 'transition',
      runId: this.runId,
      operationId,
      state,
      ...detail,
      writerEpoch: this.lease.epoch,
    });
    return true;
  }

  private appendEvent(
    eventId: string,
    payload: z.infer<typeof EffectEventSchema>,
  ): void {
    this.journal.transaction(this.lease, (transaction) => {
      transaction.appendEvent(eventId, payload);
    });
  }
}

export function createJournaledEffects(input: {
  readonly journal: WorkflowJournal;
  readonly lease: JournalLease;
  readonly runId: string;
}): JournaledEffects {
  return new JournaledEffects(input);
}

export function readJournaledEffects(
  snapshot: JournalSnapshot,
  runId: string,
): readonly JournaledEffect[] {
  const outbox = snapshot.outbox;
  return snapshot.operations.flatMap((record) => {
    if (!hasRecordType(record.effect, 'workflow-effect')) return [];
    const parsed = EffectRecordSchema.safeParse(record.effect);
    if (!parsed.success) throw corruptEffect(record.operationId);
    if (parsed.data.runId !== runId) return [];
    let state: EffectState = 'intent';
    let mutationStage: 'create' | 'prompt' | undefined;
    let externalId: string | undefined;
    for (const event of effectEvents(snapshot, runId, record.operationId)) {
      if (event.kind === 'mutation') {
        if (!isFinal(state)) mutationStage = event.stage;
        continue;
      }
      if (event.state === state) {
        externalId = event.externalId ?? externalId;
        continue;
      }
      if (isFinal(state)) continue;
      if (!transitionAllowed(state, event.state))
        throw corruptEffect(record.operationId);
      state = event.state;
      externalId = event.externalId ?? externalId;
    }
    const result = readEffectResult(record.operationId, state, record.result);
    return [
      {
        runId,
        operation: parsed.data.operation,
        writerEpoch: parsed.data.writerEpoch,
        state,
        ...(mutationStage === undefined ? {} : { mutationStage }),
        ...(externalId === undefined ? {} : { externalId }),
        result,
        resultDelivered: outbox.some(
          (entry) =>
            entry.operationId === record.operationId &&
            entry.kind === 'result' &&
            entry.status === 'delivered',
        ),
      },
    ];
  });
}

export function readGuestCompletion(
  snapshot: JournalSnapshot,
  runId: string,
): GuestCompletion | undefined {
  for (const event of snapshot.events) {
    if (!hasRecordType(event.payload, 'workflow-guest-event')) continue;
    const parsed = GuestEventSchema.safeParse(event.payload);
    if (!parsed.success) throw corruptEffect(event.eventId);
    if (parsed.data.kind === 'guest-completed' && parsed.data.runId === runId) {
      return {
        operationId: parsed.data.operationId,
        value: parsed.data.value,
      };
    }
  }
  return undefined;
}

function checkpointMetadata(
  checkpoint: InterpreterCheckpoint,
  journalCursor: number,
  deliveryCursor: number,
  writerEpoch: number,
): z.infer<typeof PersistedCheckpointMetadataSchema> {
  const { vmSnapshot: _snapshot, ...metadata } = checkpoint;
  return PersistedCheckpointMetadataSchema.parse({
    ...metadata,
    recordType: 'workflow-checkpoint',
    operationIds: checkpoint.pendingOperations.map((operation) => operation.id),
    journalCursor,
    deliveryCursor,
    writerEpoch,
  });
}

function contiguousDeliveryCursor(checkpoint: InterpreterCheckpoint): number {
  const orders = checkpoint.deliveryMap
    .map((delivery) => delivery.order)
    .sort((left, right) => left - right);
  if (orders.some((order, index) => order !== index)) {
    throw new EffectProtocolError(
      'corrupt_effect',
      'checkpoint delivery order is not contiguous',
    );
  }
  return orders.length;
}

function effectEvents(
  snapshot: JournalSnapshot,
  runId: string,
  operationId: string,
): readonly z.infer<typeof EffectEventSchema>[] {
  return snapshot.events.flatMap((event) => {
    if (!hasRecordType(event.payload, 'workflow-effect-event')) return [];
    const parsed = EffectEventSchema.safeParse(event.payload);
    if (!parsed.success) throw corruptEffect(operationId);
    return parsed.data.runId === runId &&
      parsed.data.operationId === operationId
      ? [parsed.data]
      : [];
  });
}

function assertSameOperation(
  left: WorkflowOperation,
  right: WorkflowOperation,
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new EffectProtocolError(
      'corrupt_effect',
      `checkpoint operation ${right.id} changed after journaling`,
    );
  }
}

function readEffectResult(
  operationId: string,
  state: EffectState,
  persisted: unknown | null,
): unknown | null {
  if (state !== 'terminal') {
    if (persisted !== null) throw corruptEffect(operationId);
    return null;
  }
  const result = EffectResultSchema.safeParse(persisted);
  if (!result.success) throw corruptEffect(operationId);
  return result.data.value;
}

function transitionAllowed(from: EffectState, to: EffectState): boolean {
  switch (from) {
    case 'intent':
      return to === 'admitted' || to === 'uncertain';
    case 'admitted':
      return to === 'prompted' || to === 'uncertain';
    case 'prompted':
      return to === 'terminal' || to === 'uncertain';
    case 'terminal':
    case 'uncertain':
      return false;
    default:
      return assertNever(from);
  }
}

function isFinal(state: EffectState): boolean {
  return state === 'terminal' || state === 'uncertain';
}

function hasRecordType(value: unknown, expected: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'recordType' in value &&
    value.recordType === expected
  );
}

function corruptEffect(operationId: string): EffectProtocolError {
  return new EffectProtocolError(
    'corrupt_effect',
    `persisted effect is corrupt: ${operationId}`,
  );
}

function assertNever(value: never): never {
  throw new EffectProtocolError(
    'corrupt_effect',
    `unexpected effect state: ${value}`,
  );
}
