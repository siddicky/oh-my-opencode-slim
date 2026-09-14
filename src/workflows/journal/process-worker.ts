import { createBunJournal } from './bun-driver';
import {
  type JournalLease,
  LeaseLostError,
  type WorkflowJournal,
} from './types';

class WorkerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerInputError';
  }
}
class IntentionalRollbackError extends Error {}
function requireArgument(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new WorkerInputError(`missing ${name}`);
  }
  return value;
}
async function acquireLeaseWithRetry(
  journal: WorkflowJournal,
  projectId: string,
  ownerId: string,
): Promise<JournalLease | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lease = journal.acquireLease(projectId, ownerId);
    if (lease !== null) return lease;
    await Bun.sleep(10);
  }
  return null;
}
async function claimOperation(args: readonly string[]): Promise<void> {
  const database = requireArgument(args[2], 'database');
  const project = requireArgument(args[3], 'project');
  const owner = requireArgument(args[4], 'owner');
  const operation = requireArgument(args[5], 'operation');
  const journal = createBunJournal(database);
  const lease = await acquireLeaseWithRetry(journal, project, owner);
  let operationClaimed = false;
  if (lease !== null) {
    journal.transaction(lease, (transaction) => {
      operationClaimed = transaction.persistEffect(operation, { owner });
    });
    journal.releaseLease(lease);
  }
  process.stdout.write(
    `${JSON.stringify({
      epoch: lease?.epoch ?? null,
      leaseAcquired: lease !== null,
      operationClaimed,
    })}\n`,
  );
  journal.close();
}
async function snapshot(args: readonly string[]): Promise<void> {
  const database = requireArgument(args[2], 'database');
  const project = requireArgument(args[3], 'project');
  const owner = requireArgument(args[4], 'owner');
  const journal = createBunJournal(database);
  const lease = journal.acquireLease(project, owner);
  if (lease === null) throw new WorkerInputError('lease acquisition failed');
  try {
    journal.transaction(lease, (transaction) => {
      transaction.persistEffect('rolled-back-operation', { value: 'rollback' });
      throw new IntentionalRollbackError();
    });
  } catch (error) {
    if (!(error instanceof IntentionalRollbackError)) throw error;
  }
  journal.transaction(lease, (transaction) => {
    transaction.persistEffect('operation', { prompt: 'run' });
    transaction.persistResult('operation', { answer: 42 });
    transaction.persistState('run', 'run', { state: 'running' });
    const journalCursor = transaction.appendEvent('event', {
      state: 'committed',
    });
    transaction.persistCheckpoint({
      deliveryCursor: 0,
      journalCursor,
      metadata: { operationIds: ['operation'] },
      runId: 'run',
      snapshot: new Uint8Array([1, 2, 3]),
    });
  });
  const recovered = journal.recover(project);
  process.stdout.write(
    `${JSON.stringify({
      durability: journal.durability(),
      integrity: journal.integrityCheck(),
      rolledBack: recovered.operations.every(
        (operation) => operation.operationId !== 'rolled-back-operation',
      ),
      schema: journal.schemaObjects(),
      schemaVersion: journal.schemaVersion(),
      snapshot: recovered,
    })}\n`,
  );
  journal.close();
}
async function writeWithLease(args: readonly string[]): Promise<void> {
  const database = requireArgument(args[2], 'database');
  const projectId = requireArgument(args[3], 'project');
  const ownerId = requireArgument(args[4], 'owner');
  const epochText = requireArgument(args[5], 'epoch');
  const operation = requireArgument(args[6], 'operation');
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new WorkerInputError('epoch must be a positive integer');
  }
  const journal = createBunJournal(database);
  const lease: JournalLease = { epoch, ownerId, projectId };
  let rejected = false;
  try {
    journal.transaction(lease, (transaction) => {
      transaction.persistResult(operation, { value: 'stale' });
    });
  } catch (error) {
    if (!(error instanceof LeaseLostError)) throw error;
    rejected = true;
  }
  process.stdout.write(`${JSON.stringify({ rejected })}\n`);
  journal.close();
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== 'bun') throw new WorkerInputError('driver must be bun');
  const action = requireArgument(args[1], 'action');
  if (action === 'claim-operation') {
    await claimOperation(args);
    return;
  }
  if (action === 'snapshot') {
    await snapshot(args);
    return;
  }
  if (action === 'write-with-lease') {
    await writeWithLease(args);
    return;
  }
  throw new WorkerInputError(`unknown action ${action}`);
}
try {
  await main();
} catch (error) {
  if (error instanceof Error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
