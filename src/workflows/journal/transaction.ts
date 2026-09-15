import {
  APPEND_EVENT_SQL,
  INSERT_OUTBOX_SQL,
  LEASE_OWNED_SQL,
  MARK_DELIVERED_SQL,
  PERSIST_CHECKPOINT_SQL,
  PERSIST_EFFECT_SQL,
  PERSIST_RESULT_SQL,
  PERSIST_STATE_SQL,
} from './schema';
import {
  type JournalCheckpointInput,
  type JournalDatabase,
  type JournalLease,
  JournalOrderError,
  type JournalStateKind,
  type JournalTransaction,
  LEASE_EXPIRY_MS,
  LeaseLostError,
  type OutboxKind,
  type SqlValue,
} from './types';
import {
  parseOwned,
  requireCursor,
  requireIdentifier,
  serializePayload,
} from './validation';

function leaseGuardBindings(lease: JournalLease): SqlValue[] {
  return [lease.projectId, lease.ownerId, lease.epoch, LEASE_EXPIRY_MS];
}

class SqliteJournalTransaction implements JournalTransaction {
  private readonly database: JournalDatabase;
  private readonly lease: JournalLease;
  private readonly assertActive: () => void;

  constructor(
    database: JournalDatabase,
    lease: JournalLease,
    assertActive: () => void,
  ) {
    this.database = database;
    this.lease = lease;
    this.assertActive = assertActive;
  }

  persistEffect(operationId: string, payload: unknown): boolean {
    this.assertActive();
    const operation = requireIdentifier(operationId, 'operationId');
    const encoded = serializePayload(payload);
    const persisted = this.database.run(PERSIST_EFFECT_SQL, [
      this.lease.projectId,
      operation,
      encoded,
      ...leaseGuardBindings(this.lease),
    ]).changes;
    if (persisted === 0) {
      if (!this.ownsLease()) throw new LeaseLostError(this.lease);
      return false;
    }
    this.writeOutbox(operation, 'effect', encoded);
    return true;
  }

  persistResult(operationId: string, payload: unknown): void {
    this.assertActive();
    const operation = requireIdentifier(operationId, 'operationId');
    const encoded = serializePayload(payload);
    if (
      this.database.run(PERSIST_RESULT_SQL, [
        encoded,
        this.lease.projectId,
        operation,
        ...leaseGuardBindings(this.lease),
      ]).changes !== 1
    ) {
      this.throwWriteFailure(
        'result requires a durable effect without a result',
      );
    }
    this.writeOutbox(operation, 'result', encoded);
  }

  markDelivered(operationId: string, kind: OutboxKind): void {
    this.assertActive();
    const operation = requireIdentifier(operationId, 'operationId');
    if (
      this.database.run(MARK_DELIVERED_SQL, [
        this.lease.projectId,
        operation,
        kind,
        ...leaseGuardBindings(this.lease),
      ]).changes !== 1
    ) {
      this.throwWriteFailure('delivery requires a durable outbox record');
    }
  }

  persistState(
    kind: JournalStateKind,
    recordId: string,
    payload: unknown,
  ): void {
    this.assertActive();
    const record = requireIdentifier(recordId, 'recordId');
    const encoded = serializePayload(payload);
    if (
      this.database.run(PERSIST_STATE_SQL, [
        this.lease.projectId,
        kind,
        record,
        encoded,
        this.lease.epoch,
        ...leaseGuardBindings(this.lease),
      ]).changes !== 1
    ) {
      this.throwWriteFailure('state record could not be persisted');
    }
  }

  appendEvent(eventId: string, payload: unknown): number {
    this.assertActive();
    const event = requireIdentifier(eventId, 'eventId');
    const result = this.database.run(APPEND_EVENT_SQL, [
      this.lease.projectId,
      event,
      serializePayload(payload),
      this.lease.epoch,
      ...leaseGuardBindings(this.lease),
    ]);
    if (result.changes !== 1) {
      this.throwWriteFailure('event ID is already committed');
    }
    return result.lastInsertRowid;
  }

  persistCheckpoint(checkpoint: JournalCheckpointInput): void {
    this.assertActive();
    const run = requireIdentifier(checkpoint.runId, 'runId');
    const journalCursor = requireCursor(
      checkpoint.journalCursor,
      'journalCursor',
    );
    const deliveryCursor = requireCursor(
      checkpoint.deliveryCursor,
      'deliveryCursor',
    );
    if (
      this.database.run(PERSIST_CHECKPOINT_SQL, [
        this.lease.projectId,
        run,
        checkpoint.snapshot,
        journalCursor,
        deliveryCursor,
        serializePayload(checkpoint.metadata),
        this.lease.epoch,
        ...leaseGuardBindings(this.lease),
      ]).changes !== 1
    ) {
      this.throwWriteFailure('checkpoint could not be persisted');
    }
  }

  private writeOutbox(
    operationId: string,
    kind: OutboxKind,
    encoded: string,
  ): void {
    if (
      this.database.run(INSERT_OUTBOX_SQL, [
        this.lease.projectId,
        operationId,
        kind,
        encoded,
        ...leaseGuardBindings(this.lease),
      ]).changes !== 1
    ) {
      this.throwWriteFailure('outbox record is already committed');
    }
  }

  private ownsLease(): boolean {
    return parseOwned(
      this.database.get(LEASE_OWNED_SQL, leaseGuardBindings(this.lease)),
    );
  }

  private throwWriteFailure(message: string): never {
    if (!this.ownsLease()) throw new LeaseLostError(this.lease);
    throw new JournalOrderError(message);
  }
}

export function createJournalTransaction(
  database: JournalDatabase,
  lease: JournalLease,
  assertActive: () => void,
): JournalTransaction {
  return new SqliteJournalTransaction(database, lease, assertActive);
}
