import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createJournaledEffects,
  readJournaledEffects,
  StaleEffectEpochError,
} from './effects';
import { createWorkflowInterpreter } from './interpreter';
import { createBunJournal, LEASE_EXPIRY_MS } from './journal';
import {
  type ExternalEffectObservation,
  type RecoveryEffectPort,
  RecoveryError,
  recoverWorkflowRun,
} from './recovery';

const CrashPointSchema = z.enum([
  'checkpoint-commit',
  'before-create-ack',
  'after-create-ack',
  'prompt-ack',
  'result-commit',
  'guest-delivery',
]);
type CrashPoint = z.infer<typeof CrashPointSchema>;

const MarkerSchema = z.object({
  operationId: z.string(),
  pid: z.number().int().positive(),
  writerEpoch: z.number().int().positive(),
});

const ExternalStateSchema = z.object({
  createCount: z.number().int().nonnegative(),
  promptCount: z.number().int().nonnegative(),
  resultCount: z.number().int().nonnegative(),
  quarantineCount: z.number().int().nonnegative(),
  stopCount: z.number().int().nonnegative(),
  externalId: z.string().optional(),
  stage: z.enum(['missing', 'admitted', 'prompted', 'terminal']),
  writerEpoch: z.number().int().nonnegative(),
});
type ExternalState = z.infer<typeof ExternalStateSchema>;

type CrashFixture = {
  readonly databasePath: string;
  readonly externalPath: string;
  readonly marker: z.infer<typeof MarkerSchema>;
  readonly projectId: string;
  readonly runId: string;
};

const workerPath = fileURLToPath(
  new URL('./recovery-process-worker.ts', import.meta.url),
);
const activeProcesses = new Set<ReturnType<typeof Bun.spawn>>();
const temporaryDirectories = new Set<string>();

function makeDirectory(point: CrashPoint): string {
  const directory = mkdtempSync(join(tmpdir(), `slim-recovery-${point}-`));
  temporaryDirectories.add(directory);
  return directory;
}

function readExternal(path: string): ExternalState {
  return ExternalStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeExternal(path: string, state: ExternalState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

async function waitForOutput(
  child: ReturnType<typeof Bun.spawn>,
): Promise<string> {
  const output = readLine(child.stdout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('timed out waiting for recovery worker')),
      5_000,
    );
  });
  try {
    return await Promise.race([output, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output;
      output += decoder.decode(value, { stream: true });
      const lineEnd = output.indexOf('\n');
      if (lineEnd >= 0) return output.slice(0, lineEnd);
    }
  } finally {
    reader.releaseLock();
  }
}

async function crashAt(point: CrashPoint): Promise<CrashFixture> {
  const directory = makeDirectory(point);
  const databasePath = join(directory, 'journal.sqlite');
  const externalPath = join(directory, 'external.json');
  const projectId = `project-${point}`;
  const runId = `run-${point}`;
  writeExternal(externalPath, {
    createCount: 0,
    promptCount: 0,
    resultCount: 0,
    quarantineCount: 0,
    stopCount: 0,
    stage: 'missing',
    writerEpoch: 0,
  });
  const child = Bun.spawn(
    [
      process.execPath,
      workerPath,
      point,
      databasePath,
      externalPath,
      projectId,
      runId,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  activeProcesses.add(child);
  const output = await waitForOutput(child);
  const marker = MarkerSchema.parse(JSON.parse(output));
  child.kill('SIGKILL');
  expect(await child.exited).not.toBe(0);
  activeProcesses.delete(child);
  return { databasePath, externalPath, marker, projectId, runId };
}

function expireCrashedLease(fixture: CrashFixture): void {
  const database = new Database(fixture.databasePath, { strict: true });
  database.exec(`
    UPDATE project_leases
    SET heartbeat_at_ms =
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      - ${LEASE_EXPIRY_MS + 1}
    WHERE project_id = '${fixture.projectId}'
  `);
  database.close();
}

function createRecoveryPort(externalPath: string): RecoveryEffectPort {
  return {
    async inspect(): Promise<ExternalEffectObservation> {
      const state = readExternal(externalPath);
      switch (state.stage) {
        case 'missing':
          return { kind: 'missing' };
        case 'admitted':
        case 'prompted':
          return {
            kind: 'live',
            externalId: state.externalId ?? 'missing-external-id',
            stage: state.stage,
            writerEpoch: state.writerEpoch,
          };
        case 'terminal':
          return {
            kind: 'terminal',
            externalId: state.externalId ?? 'missing-external-id',
            result: { answer: 42 },
            writerEpoch: state.writerEpoch,
          };
        default:
          return assertNever(state.stage);
      }
    },
    async quarantine(): Promise<void> {
      const state = readExternal(externalPath);
      writeExternal(externalPath, {
        ...state,
        quarantineCount: state.quarantineCount + 1,
      });
    },
    async stop(): Promise<'stopped'> {
      const state = readExternal(externalPath);
      writeExternal(externalPath, {
        ...state,
        stopCount: state.stopCount + 1,
      });
      return 'stopped';
    },
  };
}

afterEach(async () => {
  for (const child of activeProcesses) {
    child.kill('SIGKILL');
    await child.exited;
  }
  activeProcesses.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe('workflow crash recovery', () => {
  test('recovery result reuse after process kill', async () => {
    for (const point of [
      'checkpoint-commit',
      'result-commit',
      'guest-delivery',
    ] satisfies readonly CrashPoint[]) {
      // Given a real process killed after a durable workflow boundary.
      const fixture = await crashAt(point);
      expireCrashedLease(fixture);
      const journal = createBunJournal(fixture.databasePath);
      const lease = journal.acquireLease(fixture.projectId, 'recovery-owner');
      expect(lease?.epoch).toBeGreaterThan(fixture.marker.writerEpoch);
      if (!lease) throw new Error('recovery lease was not acquired');
      const effects = createJournaledEffects({
        journal,
        lease,
        runId: fixture.runId,
      });

      // When recovery restores the durable VM instead of restarting source.
      const recovered = await recoverWorkflowRun({
        effects,
        port: createRecoveryPort(fixture.externalPath),
        dispatch: async () => {},
      });

      // Then committed results are reused and pre-dispatch checkpoints stay safe.
      if (point === 'checkpoint-commit') {
        expect(recovered.kind).toBe('suspended');
        expect(recovered.actions).toEqual([
          { kind: 'dispatch', operationId: fixture.marker.operationId },
        ]);
      } else {
        expect(recovered.kind).toBe('completed');
        if (recovered.kind !== 'completed') {
          throw new Error('expected completed recovery');
        }
        expect(recovered.value).toBe(42);
        expect(recovered.reusedOperationIds).toEqual([
          fixture.marker.operationId,
        ]);
        expect(readExternal(fixture.externalPath)).toMatchObject({
          createCount: 1,
          promptCount: 1,
          resultCount: 1,
        });
        const repeated = await recoverWorkflowRun({
          effects,
          port: createRecoveryPort(fixture.externalPath),
          dispatch: async () => {},
        });
        expect(repeated.kind).toBe('completed');
        expect(repeated.reusedOperationIds).toEqual([
          fixture.marker.operationId,
        ]);
      }
      if (recovered.kind === 'suspended') await recovered.interpreter.dispose();

      const snapshot = journal.recover(fixture.projectId);
      expect(snapshot.operations).toHaveLength(1);
      expect(snapshot.checkpoints).toHaveLength(1);
      expect(snapshot.checkpoints[0]?.journalCursor).toBeGreaterThan(0);
      if (point !== 'checkpoint-commit') {
        expect(
          snapshot.events.filter(
            (event) => recordType(event.payload) === 'workflow-guest-event',
          ),
        ).toHaveLength(1);
        expect(
          snapshot.outbox.filter(
            (entry) => entry.kind === 'result' && entry.status === 'delivered',
          ),
        ).toHaveLength(1);
      }
      journal.releaseLease(lease);
      journal.close();
    }
  }, 30_000);

  test('recovery uncertain effect and stale completion', async () => {
    for (const point of [
      'before-create-ack',
      'after-create-ack',
      'prompt-ack',
    ] satisfies readonly CrashPoint[]) {
      // Given a killed writer whose external mutation may still exist.
      const fixture = await crashAt(point);
      expireCrashedLease(fixture);
      const journal = createBunJournal(fixture.databasePath);
      const lease = journal.acquireLease(fixture.projectId, 'recovery-owner');
      if (!lease) throw new Error('recovery lease was not acquired');
      const effects = createJournaledEffects({
        journal,
        lease,
        runId: fixture.runId,
      });

      // When the new epoch reconciles before allowing another dispatch.
      const recovered = await recoverWorkflowRun({
        effects,
        port: createRecoveryPort(fixture.externalPath),
        dispatch: async () => {},
      });

      // Then the old writer is quarantined and no mutation is duplicated.
      expect(recovered.kind).toBe('suspended');
      expect(recovered.actions).toEqual([
        {
          kind: 'uncertain',
          operationId: fixture.marker.operationId,
          stopped: true,
        },
      ]);
      expect(readExternal(fixture.externalPath)).toMatchObject({
        createCount: 1,
        promptCount: point === 'prompt-ack' ? 1 : 0,
        quarantineCount: 1,
        stopCount: 1,
      });
      await expect(
        effects.commitResult(
          fixture.marker.operationId,
          { answer: 'late' },
          fixture.marker.writerEpoch,
        ),
      ).rejects.toBeInstanceOf(StaleEffectEpochError);
      expect(effects.acknowledgePrompted(fixture.marker.operationId)).toBe(
        false,
      );
      expect(
        effects.markUncertain(fixture.marker.operationId, 'duplicate'),
      ).toBe(false);
      expect(
        readJournaledEffects(
          journal.recover(fixture.projectId),
          fixture.runId,
        )[0]?.state,
      ).toBe('uncertain');
      if (recovered.kind === 'suspended') await recovered.interpreter.dispose();
      journal.releaseLease(lease);
      journal.close();
    }

    // Given a missing effect followed by an identified live effect.
    const orderingDirectory = makeDirectory('checkpoint-commit');
    const orderingJournal = createBunJournal(
      join(orderingDirectory, 'ordering.sqlite'),
    );
    const orderingLease = orderingJournal.acquireLease(
      'ordering-project',
      'ordering-owner',
    );
    if (!orderingLease) throw new Error('ordering lease was not acquired');
    const orderingEffects = createJournaledEffects({
      journal: orderingJournal,
      lease: orderingLease,
      runId: 'ordering-run',
    });
    const orderingInterpreter = await createWorkflowInterpreter({
      identity: { runId: 'ordering-run', nodeId: 'node', attempt: 1 },
      coordinator: orderingEffects,
      dispatch: async () => {},
    });
    await orderingInterpreter.run(`
      task({ order: 0 });
      task({ order: 1 });
    `);
    await orderingInterpreter.dispose();
    const recoveryOrder: string[] = [];

    // When recovery reconciles both effects.
    const orderedRecovery = await recoverWorkflowRun({
      effects: orderingEffects,
      port: {
        async inspect(effect): Promise<ExternalEffectObservation> {
          if (effect.operation.sequence === 0) return { kind: 'missing' };
          return {
            kind: 'live',
            externalId: 'live-session',
            stage: 'admitted',
            writerEpoch: orderingLease.epoch,
          };
        },
        async quarantine(effect): Promise<void> {
          recoveryOrder.push(`quarantine:${effect.operation.sequence}`);
        },
        async stop(effect): Promise<'stopped'> {
          recoveryOrder.push(`stop:${effect.operation.sequence}`);
          return 'stopped';
        },
      },
      dispatch: async (operation) => {
        recoveryOrder.push(`dispatch:${operation.sequence}`);
      },
    });

    // Then the live effect is stopped before any missing effect is dispatched.
    expect(recoveryOrder).toEqual(['quarantine:1', 'stop:1', 'dispatch:0']);
    if (orderedRecovery.kind === 'suspended') {
      await orderedRecovery.interpreter.dispose();
    }
    orderingJournal.releaseLease(orderingLease);
    orderingJournal.close();

    // Given preserved evidence whose snapshot blob is corrupt.
    const corrupt = await crashAt('checkpoint-commit');
    expireCrashedLease(corrupt);
    const database = new Database(corrupt.databasePath, { strict: true });
    database.exec(
      `UPDATE checkpoints SET snapshot = X'00' WHERE run_id = '${corrupt.runId}'`,
    );
    database.close();
    const journal = createBunJournal(corrupt.databasePath);
    const lease = journal.acquireLease(corrupt.projectId, 'corrupt-owner');
    if (!lease) throw new Error('corrupt recovery lease was not acquired');
    const effects = createJournaledEffects({
      journal,
      lease,
      runId: corrupt.runId,
    });

    // When restoration reads the incompatible checkpoint.
    const recovery = recoverWorkflowRun({
      effects,
      port: createRecoveryPort(corrupt.externalPath),
      dispatch: async () => {},
    });

    // Then it reports recovery_error and leaves all source evidence intact.
    await expect(recovery).rejects.toBeInstanceOf(RecoveryError);
    expect(journal.recover(corrupt.projectId).operations).toHaveLength(1);
    expect(readExternal(corrupt.externalPath).createCount).toBe(0);
    journal.releaseLease(lease);
    journal.close();
  }, 30_000);
});

function assertNever(value: never): never {
  throw new Error(`unexpected external stage: ${value}`);
}

function recordType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('recordType' in value)) {
    return undefined;
  }
  return typeof value.recordType === 'string' ? value.recordType : undefined;
}
