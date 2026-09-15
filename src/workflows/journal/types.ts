export const LEASE_HEARTBEAT_MS = 5_000;
export const LEASE_EXPIRY_MS = 30_000;

export type OutboxKind = 'effect' | 'result';
export type OutboxStatus = 'pending' | 'delivered';
export type JournalStateKind =
  | 'approval'
  | 'node-attempt'
  | 'reservation'
  | 'run';
export type JournalLease = {
  readonly projectId: string;
  readonly ownerId: string;
  readonly epoch: number;
};
export type JournalOperation = {
  readonly operationId: string;
  readonly effect: unknown;
  readonly result: unknown;
};
export type JournalOutboxEntry = {
  readonly operationId: string;
  readonly kind: OutboxKind;
  readonly payload: unknown;
  readonly status: OutboxStatus;
};
export type JournalStateRecord = {
  readonly kind: JournalStateKind;
  readonly recordId: string;
  readonly payload: unknown;
};
export type JournalEvent = {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: unknown;
};
export type JournalCheckpoint = {
  readonly runId: string;
  readonly snapshot: Uint8Array;
  readonly journalCursor: number;
  readonly deliveryCursor: number;
  readonly metadata: unknown;
};
export type JournalCheckpointInput = JournalCheckpoint;
export type JournalSchemaObject = {
  readonly type: 'table';
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
};
export type JournalSnapshot = {
  readonly operations: readonly JournalOperation[];
  readonly outbox: readonly JournalOutboxEntry[];
  readonly states: readonly JournalStateRecord[];
  readonly events: readonly JournalEvent[];
  readonly checkpoints: readonly JournalCheckpoint[];
};
export type JournalDurability = {
  readonly journalMode: 'wal';
  readonly foreignKeys: true;
  readonly synchronous: 'full';
};
export interface JournalTransaction {
  persistEffect(operationId: string, payload: unknown): boolean;
  persistResult(operationId: string, payload: unknown): void;
  markDelivered(operationId: string, kind: OutboxKind): void;
  persistState(
    kind: JournalStateKind,
    recordId: string,
    payload: unknown,
  ): void;
  appendEvent(eventId: string, payload: unknown): number;
  persistCheckpoint(checkpoint: JournalCheckpointInput): void;
}
export interface WorkflowJournal {
  acquireLease(projectId: string, ownerId: string): JournalLease | null;
  releaseLease(lease: JournalLease): void;
  heartbeat(lease: JournalLease): boolean;
  transaction(
    lease: JournalLease,
    callback: (transaction: JournalTransaction) => unknown,
  ): void;
  recover(projectId: string): JournalSnapshot;
  schemaObjects(): readonly JournalSchemaObject[];
  durability(): JournalDurability;
  schemaVersion(): number;
  integrityCheck(): string;
  close(): void;
}
export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRunResult = {
  readonly changes: number;
  readonly lastInsertRowid: number;
};
export interface JournalDatabase {
  exec(sql: string): void;
  run(sql: string, bindings?: SqlValue[]): SqlRunResult;
  get(sql: string, bindings?: SqlValue[]): unknown;
  all(sql: string, bindings?: SqlValue[]): readonly unknown[];
  close(): void;
}
export class AsyncJournalTransactionError extends Error {
  constructor() {
    super('journal transactions must complete synchronously');
    this.name = 'AsyncJournalTransactionError';
  }
}
export class LeaseLostError extends Error {
  readonly lease: JournalLease;
  constructor(lease: JournalLease) {
    super(`journal lease lost for project ${lease.projectId}`);
    this.name = 'LeaseLostError';
    this.lease = lease;
  }
}
export class JournalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalInputError';
  }
}
export class JournalOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalOrderError';
  }
}
export class JournalBusyError extends Error {
  constructor() {
    super('journal remained busy after bounded retry');
    this.name = 'JournalBusyError';
  }
}
export class JournalMigrationError extends Error {
  constructor(version: number) {
    super(`journal schema version ${version} is newer than this runtime`);
    this.name = 'JournalMigrationError';
  }
}
