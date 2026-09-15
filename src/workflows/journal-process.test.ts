import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBunJournal } from './journal';

type DriverName = 'bun' | 'node';
type ChildResult = { readonly exitCode: number; readonly stdout: string };

const activeProcesses = new Set<ReturnType<typeof Bun.spawn>>();
const temporaryDirectories = new Set<string>();
const workerPath = fileURLToPath(
  new URL('./journal/process-worker.ts', import.meta.url),
);
const nodeWorkerSource = fileURLToPath(
  new URL('./journal/node-process-worker.ts', import.meta.url),
);
const nodeWorkerDirectory = mkdtempSync(
  join(tmpdir(), 'slim-node-journal-worker-'),
);
const nodeWorkerPath = join(nodeWorkerDirectory, 'worker.mjs');
const nodeWorkerBuild = Bun.spawnSync([
  'bun',
  'build',
  nodeWorkerSource,
  '--target=node',
  '--format=esm',
  `--outfile=${nodeWorkerPath}`,
]);
if (nodeWorkerBuild.exitCode !== 0) {
  rmSync(nodeWorkerDirectory, { force: true, recursive: true });
  throw new Error(new TextDecoder().decode(nodeWorkerBuild.stderr));
}

function makeDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `slim-process-${name}-`));
  temporaryDirectories.add(directory);
  return directory;
}

function command(driver: DriverName, args: readonly string[]): string[] {
  return driver === 'bun'
    ? ['bun', workerPath, driver, ...args]
    : ['node', nodeWorkerPath, driver, ...args];
}

async function runChild(
  driver: DriverName,
  args: readonly string[],
): Promise<ChildResult> {
  const process = Bun.spawn(command(driver, args), {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  activeProcesses.add(process);
  const timer = setTimeout(() => process.kill('SIGKILL'), 5_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  clearTimeout(timer);
  activeProcesses.delete(process);
  if (exitCode !== 0) {
    throw new Error(`child failed (${exitCode}): ${stderr}`);
  }
  return { exitCode, stdout: stdout.trim() };
}

async function waitForMarker(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await Bun.sleep(10);
  }
}

async function killWriter(
  database: string,
  marker: string,
  phase: 'begun' | 'inserted',
): Promise<void> {
  const process = Bun.spawn(
    command('node', ['hold', database, marker, phase]),
    { stderr: 'pipe', stdout: 'pipe' },
  );
  activeProcesses.add(process);
  await waitForMarker(marker);
  process.kill('SIGKILL');
  await process.exited;
  activeProcesses.delete(process);
}

afterEach(async () => {
  for (const process of activeProcesses) {
    process.kill('SIGKILL');
    await process.exited;
  }
  activeProcesses.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

afterAll(() => {
  rmSync(nodeWorkerDirectory, { force: true, recursive: true });
});

describe('workflow journal process safety', () => {
  test('journal process driver parity', async () => {
    const bunDatabase = join(makeDirectory('bun-parity'), 'journal.sqlite');
    const nodeDatabase = join(makeDirectory('node-parity'), 'journal.sqlite');
    const [bunResult, nodeResult] = await Promise.all([
      runChild('bun', ['snapshot', bunDatabase, 'project', 'bun-owner']),
      runChild('node', ['snapshot', nodeDatabase, 'project', 'node-owner']),
    ]);

    expect(bunResult.exitCode).toBe(0);
    expect(nodeResult.exitCode).toBe(0);
    const bunSnapshot = JSON.parse(bunResult.stdout);
    const nodeSnapshot = JSON.parse(nodeResult.stdout);
    expect(bunSnapshot.rolledBack).toBe(true);
    expect(nodeSnapshot.rolledBack).toBe(true);
    expect(bunSnapshot.schema).not.toEqual([]);
    expect(bunSnapshot).toEqual(nodeSnapshot);
  });

  test('journal two scheduler processes cannot claim the same operation', async () => {
    const directory = makeDirectory('operation-claim');
    const database = join(directory, 'journal.sqlite');
    const [bunResult, nodeResult] = await Promise.all([
      runChild('bun', [
        'claim-operation',
        database,
        'project',
        'bun-owner',
        'shared-operation',
      ]),
      runChild('node', [
        'claim-operation',
        database,
        'project',
        'node-owner',
        'shared-operation',
      ]),
    ]);
    const results = [bunResult, nodeResult].map((result) =>
      JSON.parse(result.stdout),
    );

    expect(bunResult.exitCode).toBe(0);
    expect(nodeResult.exitCode).toBe(0);
    expect(
      results.filter((result) => result.operationClaimed === true),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.leaseAcquired === true),
    ).toHaveLength(2);
    expect(new Set(results.map((result) => result.epoch)).size).toBe(2);
    const reopened = createBunJournal(database);
    const recovered = reopened.recover('project');
    expect(recovered.operations).toHaveLength(1);
    expect(recovered.operations[0]?.operationId).toBe('shared-operation');
    expect(recovered.outbox).toHaveLength(1);
    reopened.close();
  });

  test('journal killed writer loses only uncommitted work', async () => {
    const directory = makeDirectory('crash');
    const database = join(directory, 'journal.sqlite');
    const bootstrap = createBunJournal(database);
    const lease = bootstrap.acquireLease('crash-project', 'bootstrap-owner');
    expect(lease).not.toBeNull();
    if (lease) {
      bootstrap.transaction(lease, (transaction) => {
        transaction.persistEffect('committed-operation', { committed: true });
      });
    }
    bootstrap.close();

    await killWriter(database, join(directory, 'begun.ready'), 'begun');
    await killWriter(database, join(directory, 'inserted.ready'), 'inserted');

    const reopened = createBunJournal(database);
    expect(reopened.recover('crash-project').operations).toEqual([
      {
        effect: { committed: true },
        operationId: 'committed-operation',
        result: null,
      },
    ]);
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });

  test('journal stale epoch cannot update state', async () => {
    const directory = makeDirectory('stale-epoch');
    const database = join(directory, 'journal.sqlite');
    const journal = createBunJournal(database);
    const stale = journal.acquireLease('project', 'owner-a');
    expect(stale).not.toBeNull();
    if (!stale) {
      journal.close();
      return;
    }
    journal.transaction(stale, (transaction) => {
      transaction.persistEffect('operation', { value: 'committed' });
    });
    journal.releaseLease(stale);
    const current = journal.acquireLease('project', 'owner-b');
    expect(current).not.toBeNull();
    expect(current?.epoch).not.toBe(stale.epoch);

    const result = await runChild('node', [
      'write-with-lease',
      database,
      stale.projectId,
      stale.ownerId,
      String(stale.epoch),
      'operation',
    ]);

    expect(JSON.parse(result.stdout)).toEqual({ rejected: true });
    expect(journal.recover('project').operations).toEqual([
      {
        effect: { value: 'committed' },
        operationId: 'operation',
        result: null,
      },
    ]);
    journal.close();
  });
});
