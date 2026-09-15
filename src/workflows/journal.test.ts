import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureBackgroundJobPersistence,
  loadInitialBackgroundJobPersistence,
} from '../utils/background-job-persistence';
import {
  AsyncJournalTransactionError,
  createBunJournal,
  JournalBusyError,
  JournalMigrationError,
  LEASE_EXPIRY_MS,
  LEASE_HEARTBEAT_MS,
  LeaseLostError,
  type WorkflowJournal,
} from './journal';
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION } from './journal/schema';

const temporaryDirectories = new Set<string>();

function databasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `slim-journal-${name}-`));
  temporaryDirectories.add(directory);
  return join(directory, 'journal.sqlite');
}

function exerciseCommittedRecovery(journal: WorkflowJournal): void {
  const lease = journal.acquireLease('project', 'owner');
  expect(lease).not.toBeNull();
  if (!lease) {
    return;
  }
  journal.transaction(lease, (transaction) => {
    transaction.persistEffect('operation-1', { prompt: 'run' });
    transaction.persistResult('operation-1', { answer: 42 });
    transaction.persistState('run', 'run-1', {
      id: 'run-1',
      planId: 'plan-1',
      state: 'running',
    });
    transaction.persistState('node-attempt', 'run-1:node-1:1', {
      attempt: 1,
      nodeId: 'node-1',
      runId: 'run-1',
      state: 'running',
    });
    transaction.persistState('approval', 'plan-1', {
      approvedDigest: `sha256:${'a'.repeat(64)}`,
      planId: 'plan-1',
    });
    transaction.persistState('reservation', 'reservation-1', {
      providerId: 'provider-a',
      tokenCeiling: 1_000,
    });
    const journalCursor = transaction.appendEvent('event-1', {
      state: 'effect-committed',
    });
    transaction.persistCheckpoint({
      deliveryCursor: 0,
      journalCursor,
      metadata: { operationIds: ['operation-1'] },
      runId: 'run-1',
      snapshot: new Uint8Array([1, 2, 3]),
    });
  });
}

describe('workflow journal', () => {
  afterEach(() => {
    setSystemTime();
    configureBackgroundJobPersistence(undefined);
    for (const directory of temporaryDirectories) {
      rmSync(directory, { force: true, recursive: true });
    }
    temporaryDirectories.clear();
  });

  test('existing job-board persistence remains empty without a backend', async () => {
    configureBackgroundJobPersistence(undefined);

    const persisted = await loadInitialBackgroundJobPersistence();

    expect(persisted.tombstones.size).toBe(0);
    expect(persisted.deletionEpochs.size).toBe(0);
    expect(persisted.aliasHighWaterMarks.size).toBe(0);
    expect(persisted.nextEpoch).toBe(0);
  });

  test('journal transaction rollback', () => {
    const journal = createBunJournal(databasePath('rollback'));
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    if (!lease) {
      journal.close();
      return;
    }

    expect(() =>
      journal.transaction(lease, (transaction) => {
        transaction.persistEffect('operation-rollback', { value: 1 });
        transaction.persistState('run', 'run-rollback', { state: 'running' });
        transaction.appendEvent('event-rollback', { state: 'running' });
        throw new RangeError('abort transaction');
      }),
    ).toThrow('abort transaction');
    expect(journal.recover('project')).toEqual({
      checkpoints: [],
      events: [],
      operations: [],
      outbox: [],
      states: [],
    });
    journal.close();
  });

  test('journal committed recovery', () => {
    const path = databasePath('recovery');
    const first = createBunJournal(path);
    exerciseCommittedRecovery(first);
    first.close();

    const reopened = createBunJournal(path);
    expect(reopened.recover('project')).toEqual({
      operations: [
        {
          operationId: 'operation-1',
          effect: { prompt: 'run' },
          result: { answer: 42 },
        },
      ],
      outbox: [
        {
          operationId: 'operation-1',
          kind: 'effect',
          payload: { prompt: 'run' },
          status: 'pending',
        },
        {
          operationId: 'operation-1',
          kind: 'result',
          payload: { answer: 42 },
          status: 'pending',
        },
      ],
      states: [
        {
          kind: 'approval',
          payload: {
            approvedDigest: `sha256:${'a'.repeat(64)}`,
            planId: 'plan-1',
          },
          recordId: 'plan-1',
        },
        {
          kind: 'node-attempt',
          payload: {
            attempt: 1,
            nodeId: 'node-1',
            runId: 'run-1',
            state: 'running',
          },
          recordId: 'run-1:node-1:1',
        },
        {
          kind: 'reservation',
          payload: { providerId: 'provider-a', tokenCeiling: 1_000 },
          recordId: 'reservation-1',
        },
        {
          kind: 'run',
          payload: { id: 'run-1', planId: 'plan-1', state: 'running' },
          recordId: 'run-1',
        },
      ],
      events: [
        {
          eventId: 'event-1',
          payload: { state: 'effect-committed' },
          sequence: 1,
        },
      ],
      checkpoints: [
        {
          deliveryCursor: 0,
          journalCursor: 1,
          metadata: { operationIds: ['operation-1'] },
          runId: 'run-1',
          snapshot: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    reopened.close();
  });

  test('journal stale owner rejected', () => {
    const journal = createBunJournal(databasePath('stale'));
    const original = journal.acquireLease('project', 'owner-a');
    expect(original).not.toBeNull();
    if (!original) {
      journal.close();
      return;
    }
    journal.transaction(original, (transaction) => {
      transaction.persistEffect('operation-stable', { value: 'committed' });
    });
    journal.releaseLease(original);
    const replacement = journal.acquireLease('project', 'owner-b');
    expect(replacement?.epoch).not.toBe(original.epoch);
    expect(() => journal.releaseLease(original)).toThrow(LeaseLostError);

    let staleCallbackInvoked = false;
    expect(() =>
      journal.transaction(original, (transaction) => {
        staleCallbackInvoked = true;
        transaction.persistResult('operation-stable', { value: 'stale' });
      }),
    ).toThrow(LeaseLostError);
    expect(staleCallbackInvoked).toBe(false);
    expect(journal.recover('project').operations).toEqual([
      {
        operationId: 'operation-stable',
        effect: { value: 'committed' },
        result: null,
      },
    ]);
    journal.close();
  });

  test('journal applies versioned migrations and rejects newer schemas', () => {
    const path = databasePath('migration');
    const versionOne = new Database(path, { strict: true });
    versionOne.exec(JOURNAL_MIGRATIONS[0].sql);
    versionOne.exec(`
      INSERT INTO operations (
        project_id, operation_id, effect_json, result_json
      ) VALUES ('legacy-project', 'legacy-operation', '{"version":1}', NULL);
      INSERT INTO outbox (
        project_id, operation_id, kind, payload_json, status
      ) VALUES (
        'legacy-project', 'legacy-operation', 'effect', '{"version":1}',
        'pending'
      );
    `);
    versionOne.exec('PRAGMA user_version = 1');
    versionOne.close();

    const migrated = createBunJournal(path);
    expect(migrated.schemaVersion()).toBe(JOURNAL_SCHEMA_VERSION);
    expect(migrated.schemaObjects().map((object) => object.name)).toEqual([
      'checkpoints',
      'journal_events',
      'lease_epochs',
      'operations',
      'outbox',
      'project_leases',
      'state_records',
    ]);
    expect(migrated.recover('legacy-project').operations).toEqual([
      {
        effect: { version: 1 },
        operationId: 'legacy-operation',
        result: null,
      },
    ]);
    migrated.close();

    const futurePath = databasePath('future-migration');
    const future = new Database(futurePath, { strict: true });
    future.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION + 1}`);
    future.close();
    expect(() => createBunJournal(futurePath)).toThrow(JournalMigrationError);
  });

  test('journal rejects malformed input without mutation', () => {
    const journal = createBunJournal(databasePath('malformed'));
    expect(() => journal.acquireLease('', 'owner')).toThrow();
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    if (!lease) {
      journal.close();
      return;
    }
    expect(() =>
      journal.transaction(lease, (transaction) => {
        transaction.persistEffect('', { valid: true });
      }),
    ).toThrow();
    expect(() =>
      journal.transaction(lease, (transaction) => {
        transaction.persistEffect('operation-invalid', undefined);
      }),
    ).toThrow();
    expect(journal.recover('project')).toEqual({
      checkpoints: [],
      events: [],
      operations: [],
      outbox: [],
      states: [],
    });
    journal.close();
  });

  test('journal ownership is unique and uses configured lease timing', () => {
    const path = databasePath('ownership');
    const first = createBunJournal(path);
    const second = createBunJournal(path);
    const lease = first.acquireLease('project', 'owner-a');
    expect(lease).not.toBeNull();
    expect(second.acquireLease('project', 'owner-b')).toBeNull();
    expect(LEASE_HEARTBEAT_MS).toBe(5_000);
    expect(LEASE_EXPIRY_MS).toBe(30_000);
    if (lease) {
      expect(first.heartbeat(lease)).toBe(true);
      first.releaseLease(lease);
      const reacquired = second.acquireLease('project', 'owner-b');
      expect(reacquired?.epoch).not.toBe(lease.epoch);
    }
    first.close();
    second.close();
  });

  test('journal lease comparison uses database time and exact expiry', () => {
    const path = databasePath('database-time');
    const first = createBunJournal(path);
    const second = createBunJournal(path);
    const original = first.acquireLease('project', 'owner-a');
    expect(original).not.toBeNull();
    setSystemTime(new Date('2100-01-01T00:00:00.000Z'));
    expect(second.acquireLease('project', 'owner-b')).toBeNull();
    setSystemTime();

    const database = new Database(path, { strict: true });
    database.exec(`
      UPDATE project_leases
      SET heartbeat_at_ms =
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        - ${LEASE_EXPIRY_MS + 1}
      WHERE project_id = 'project'
    `);
    database.close();
    const replacement = second.acquireLease('project', 'owner-b');
    expect(replacement).not.toBeNull();
    expect(replacement?.epoch).not.toBe(original?.epoch);
    first.close();
    second.close();
  });

  test(
    'journal automatically heartbeats an acquired lease every five seconds',
    async () => {
      const path = databasePath('automatic-heartbeat');
      const first = createBunJournal(path);
      const second = createBunJournal(path);
      try {
        const lease = first.acquireLease('project', 'owner-a');
        expect(lease).not.toBeNull();
        const beforeDatabase = new Database(path, { strict: true });
        const before = beforeDatabase
          .query(
            `SELECT heartbeat_at_ms FROM project_leases
             WHERE project_id = 'project'`,
          )
          .get();
        beforeDatabase.close();

        await Bun.sleep(LEASE_HEARTBEAT_MS + 250);

        const afterDatabase = new Database(path, { strict: true });
        const after = afterDatabase
          .query(
            `SELECT heartbeat_at_ms FROM project_leases
             WHERE project_id = 'project'`,
          )
          .get();
        afterDatabase.close();
        expect(after).not.toEqual(before);
        expect(second.acquireLease('project', 'owner-b')).toBeNull();
        if (lease) first.releaseLease(lease);
      } finally {
        first.close();
        second.close();
      }
    },
    LEASE_HEARTBEAT_MS + 2_000,
  );

  test('journal busy retry is bounded', () => {
    const path = databasePath('busy');
    const journal = createBunJournal(path);
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    const lock = new Database(path, { strict: true });
    try {
      lock.exec('BEGIN IMMEDIATE');
      const startedAt = performance.now();
      expect(() => lease && journal.heartbeat(lease)).toThrow(JournalBusyError);
      // Bounded retry: 8 attempts x (100ms busy_timeout + 25ms wait) is
      // ~1s logical worst case. Wall clock can overshoot under parallel
      // suite load (observed 3.4s), so treat this as a hang detector,
      // not a latency budget.
      expect(performance.now() - startedAt).toBeLessThan(15_000);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
      journal.close();
    }
  }, 30_000);

  test('journal requires synchronous transactions', async () => {
    const path = databasePath('synchronous');
    const journal = createBunJournal(path);
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    if (!lease) {
      journal.close();
      return;
    }
    let resolvePending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    expect(() =>
      journal.transaction(lease, (transaction) => {
        transaction.persistEffect('operation-async', { value: 1 });
        return pending;
      }),
    ).toThrow(AsyncJournalTransactionError);
    expect(journal.recover('project').operations).toEqual([]);
    const competingWriter = new Database(path, { strict: true });
    expect(() => competingWriter.exec('BEGIN IMMEDIATE')).not.toThrow();
    competingWriter.exec('ROLLBACK');
    competingWriter.close();
    resolvePending?.();
    await pending;

    const thenable = Object.defineProperty({}, 'then', {
      value: () => undefined,
    });
    expect(() =>
      journal.transaction(lease, (transaction) => {
        transaction.persistEffect('operation-thenable', { value: 2 });
        return thenable;
      }),
    ).toThrow(AsyncJournalTransactionError);
    expect(journal.recover('project').operations).toEqual([]);
    journal.close();
  });

  test('journal commits effect outbox before dispatch', () => {
    const journal = createBunJournal(databasePath('effect-outbox'));
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    if (!lease) {
      journal.close();
      return;
    }
    journal.transaction(lease, (transaction) => {
      transaction.persistEffect('operation-order', { dispatch: 'after' });
    });
    expect(journal.recover('project').outbox).toEqual([
      {
        operationId: 'operation-order',
        kind: 'effect',
        payload: { dispatch: 'after' },
        status: 'pending',
      },
    ]);
    journal.transaction(lease, (transaction) => {
      transaction.markDelivered('operation-order', 'effect');
    });
    expect(journal.recover('project').outbox[0]?.status).toBe('delivered');
    journal.close();
  });

  test('journal commits result outbox before delivery', () => {
    const journal = createBunJournal(databasePath('result-outbox'));
    const lease = journal.acquireLease('project', 'owner');
    expect(lease).not.toBeNull();
    if (!lease) {
      journal.close();
      return;
    }
    journal.transaction(lease, (transaction) => {
      transaction.persistEffect('operation-order', { dispatch: 'before' });
      transaction.markDelivered('operation-order', 'effect');
    });
    journal.transaction(lease, (transaction) => {
      transaction.persistResult('operation-order', { delivery: 'after' });
    });
    expect(journal.recover('project').outbox).toEqual([
      {
        operationId: 'operation-order',
        kind: 'effect',
        payload: { dispatch: 'before' },
        status: 'delivered',
      },
      {
        operationId: 'operation-order',
        kind: 'result',
        payload: { delivery: 'after' },
        status: 'pending',
      },
    ]);
    journal.transaction(lease, (transaction) => {
      transaction.markDelivered('operation-order', 'result');
    });
    expect(journal.recover('project').outbox[1]?.status).toBe('delivered');
    journal.close();
  });
});
