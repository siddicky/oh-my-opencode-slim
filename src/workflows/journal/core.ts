import { readSchemaObjects, recoverJournal } from './recovery';
import {
  ACQUIRE_LEASE_SQL,
  HEARTBEAT_SQL,
  JOURNAL_MIGRATIONS,
  JOURNAL_SCHEMA_VERSION,
  LEASE_OWNED_SQL,
  RELEASE_LEASE_SQL,
} from './schema';
import { createJournalTransaction } from './transaction';
import {
  AsyncJournalTransactionError,
  JournalBusyError,
  type JournalDatabase,
  type JournalDurability,
  type JournalLease,
  JournalMigrationError,
  type JournalSchemaObject,
  type JournalSnapshot,
  type JournalTransaction,
  LEASE_EXPIRY_MS,
  LEASE_HEARTBEAT_MS,
  LeaseLostError,
  type SqlValue,
  type WorkflowJournal,
} from './types';
import {
  parseForeignKeys,
  parseIntegrity,
  parseJournalMode,
  parseOwned,
  parseSynchronous,
  parseVersion,
  requireIdentifier,
} from './validation';

const BUSY_RETRY_ATTEMPTS = 8;
const BUSY_RETRY_DELAY_MS = 25;
const RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:SQLITE_BUSY|database is locked|database is busy)/i.test(error.message)
  );
}
function busyRetry<T>(operation: () => T): T {
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      if (attempt === BUSY_RETRY_ATTEMPTS - 1) {
        throw new JournalBusyError();
      }
      Atomics.wait(RETRY_WAIT, 0, 0, BUSY_RETRY_DELAY_MS);
    }
  }
  throw new JournalBusyError();
}
function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  return 'then' in value && typeof value.then === 'function';
}
function leaseGuardBindings(lease: JournalLease): SqlValue[] {
  return [lease.projectId, lease.ownerId, lease.epoch, LEASE_EXPIRY_MS];
}
export class SqliteWorkflowJournal implements WorkflowJournal {
  private readonly database: JournalDatabase;
  private readonly heartbeatFailures = new Map<number, unknown>();
  private readonly heartbeatTimers = new Map<
    number,
    ReturnType<typeof setInterval>
  >();

  constructor(database: JournalDatabase) {
    this.database = database;
    this.configure();
    this.migrate();
  }
  acquireLease(projectId: string, ownerId: string): JournalLease | null {
    const project = requireIdentifier(projectId, 'projectId');
    const owner = requireIdentifier(ownerId, 'ownerId');
    let acquiredLease: JournalLease | null = null;
    this.beginImmediate();
    try {
      const epoch = this.database.run(
        'INSERT INTO lease_epochs DEFAULT VALUES',
      ).lastInsertRowid;
      const acquired = this.database.run(ACQUIRE_LEASE_SQL, [
        project,
        owner,
        epoch,
        LEASE_EXPIRY_MS,
      ]).changes;
      if (acquired !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.exec('COMMIT');
      acquiredLease = { projectId: project, ownerId: owner, epoch };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.startHeartbeat(acquiredLease);
    return acquiredLease;
  }
  releaseLease(lease: JournalLease): void {
    const released = busyRetry(
      () =>
        this.database.run(RELEASE_LEASE_SQL, leaseGuardBindings(lease)).changes,
    );
    this.stopHeartbeat(lease.epoch);
    this.heartbeatFailures.delete(lease.epoch);
    if (released !== 1) throw new LeaseLostError(lease);
  }
  heartbeat(lease: JournalLease): boolean {
    const failure = this.heartbeatFailures.get(lease.epoch);
    if (failure !== undefined) throw failure;
    const owned =
      busyRetry(
        () =>
          this.database.run(HEARTBEAT_SQL, leaseGuardBindings(lease)).changes,
      ) === 1;
    if (!owned) this.stopHeartbeat(lease.epoch);
    return owned;
  }
  transaction(
    lease: JournalLease,
    callback: (transaction: JournalTransaction) => unknown,
  ): void {
    const heartbeatFailure = this.heartbeatFailures.get(lease.epoch);
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    this.beginImmediate();
    let active = true;
    const assertActive = (): void => {
      if (!active) throw new AsyncJournalTransactionError();
    };
    try {
      if (!this.ownsLease(lease)) throw new LeaseLostError(lease);
      const transaction = createJournalTransaction(
        this.database,
        lease,
        assertActive,
      );
      const result = callback(transaction);
      active = false;
      if (isThenable(result)) throw new AsyncJournalTransactionError();
      this.database.exec('COMMIT');
    } catch (error) {
      active = false;
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  recover(projectId: string): JournalSnapshot {
    const project = requireIdentifier(projectId, 'projectId');
    return recoverJournal(this.database, project);
  }
  schemaObjects(): readonly JournalSchemaObject[] {
    return readSchemaObjects(this.database);
  }
  durability(): JournalDurability {
    const journalMode = parseJournalMode(
      this.database.get('PRAGMA journal_mode'),
    );
    const foreignKeys = parseForeignKeys(
      this.database.get('PRAGMA foreign_keys'),
    );
    const synchronous = parseSynchronous(
      this.database.get('PRAGMA synchronous'),
    );
    if (journalMode !== 'wal' || foreignKeys !== 1 || synchronous !== 2) {
      throw new JournalMigrationError(this.schemaVersion());
    }
    return { journalMode: 'wal', foreignKeys: true, synchronous: 'full' };
  }
  schemaVersion(): number {
    return parseVersion(this.database.get('PRAGMA user_version'));
  }
  integrityCheck(): string {
    return parseIntegrity(this.database.get('PRAGMA integrity_check'));
  }
  close(): void {
    for (const epoch of this.heartbeatTimers.keys()) {
      this.stopHeartbeat(epoch);
    }
    this.heartbeatFailures.clear();
    this.database.close();
  }
  private configure(): void {
    this.database.exec('PRAGMA busy_timeout = 100');
    busyRetry(() => this.database.exec('PRAGMA journal_mode = WAL'));
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA synchronous = FULL');
  }
  private migrate(): void {
    this.beginImmediate();
    try {
      const current = this.schemaVersion();
      if (current > JOURNAL_SCHEMA_VERSION) {
        throw new JournalMigrationError(current);
      }
      for (const migration of JOURNAL_MIGRATIONS) {
        if (migration.version > current) {
          this.database.exec(migration.sql);
          this.database.exec(`PRAGMA user_version = ${migration.version}`);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  private beginImmediate(): void {
    busyRetry(() => this.database.exec('BEGIN IMMEDIATE'));
  }
  private ownsLease(lease: JournalLease): boolean {
    return parseOwned(
      this.database.get(LEASE_OWNED_SQL, leaseGuardBindings(lease)),
    );
  }

  private startHeartbeat(lease: JournalLease): void {
    this.stopHeartbeat(lease.epoch);
    const timer = setInterval(() => {
      try {
        this.heartbeat(lease);
      } catch (error) {
        if (error instanceof JournalBusyError) return;
        this.heartbeatFailures.set(lease.epoch, error);
        this.stopHeartbeat(lease.epoch);
      }
    }, LEASE_HEARTBEAT_MS);
    timer.unref();
    this.heartbeatTimers.set(lease.epoch, timer);
  }

  private stopHeartbeat(epoch: number): void {
    const timer = this.heartbeatTimers.get(epoch);
    if (timer === undefined) return;
    clearInterval(timer);
    this.heartbeatTimers.delete(epoch);
  }
}
