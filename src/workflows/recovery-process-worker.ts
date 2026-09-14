import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createJournaledEffects } from './effects';
import {
  createWorkflowInterpreter,
  type WorkflowOperation,
} from './interpreter';
import { createBunJournal } from './journal';

const WorkerInputSchema = z.tuple([
  z.string(),
  z.string(),
  z.enum([
    'checkpoint-commit',
    'before-create-ack',
    'after-create-ack',
    'prompt-ack',
    'result-commit',
    'guest-delivery',
  ]),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

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

function readExternal(path: string): ExternalState {
  return ExternalStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function updateExternal(
  path: string,
  update: (current: ExternalState) => ExternalState,
): void {
  writeFileSync(path, `${JSON.stringify(update(readExternal(path)))}\n`);
}

async function signalAndWait(
  operationId: string,
  writerEpoch: number,
): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write(
      `${JSON.stringify({ operationId, pid: process.pid, writerEpoch })}\n`,
      () => process.stdout.end(resolve),
    );
  });
  return new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const [, , point, databasePath, externalPath, projectId, runId] =
    WorkerInputSchema.parse(process.argv);
  const journal = createBunJournal(databasePath);
  const lease = journal.acquireLease(projectId, `writer-${process.pid}`);
  if (!lease) throw new Error('writer lease was not acquired');
  const effects = createJournaledEffects({ journal, lease, runId });
  let dispatched: WorkflowOperation | undefined;
  const interpreter = await createWorkflowInterpreter({
    identity: { runId, nodeId: 'node', attempt: 1 },
    coordinator: effects,
    dispatch: async (operation) => {
      dispatched = operation;
      if (point === 'checkpoint-commit') {
        await signalAndWait(operation.id, lease.epoch);
      }
      effects.beginMutation(operation.id, 'create');
      updateExternal(externalPath, (current) => ({
        ...current,
        createCount: current.createCount + 1,
        externalId: `session-${operation.id}`,
        stage: 'admitted',
        writerEpoch: lease.epoch,
      }));
      if (point === 'before-create-ack') {
        await signalAndWait(operation.id, lease.epoch);
      }
      effects.acknowledgeAdmitted(operation.id, `session-${operation.id}`);
      if (point === 'after-create-ack') {
        await signalAndWait(operation.id, lease.epoch);
      }
      effects.beginMutation(operation.id, 'prompt');
      updateExternal(externalPath, (current) => ({
        ...current,
        promptCount: current.promptCount + 1,
        stage: 'prompted',
      }));
      effects.acknowledgePrompted(operation.id);
      if (point === 'prompt-ack') {
        await signalAndWait(operation.id, lease.epoch);
      }
      updateExternal(externalPath, (current) => ({
        ...current,
        resultCount: current.resultCount + 1,
        stage: 'terminal',
      }));
      await effects.commitResult(operation.id, { answer: 42 }, lease.epoch);
      if (point === 'result-commit') {
        await signalAndWait(operation.id, lease.epoch);
      }
    },
  });
  const suspended = await interpreter.run(`
    globalThis.output = 'waiting';
    task({ value: 21 }).then((value) => {
      globalThis.output = value.answer;
    });
  `);
  if (point !== 'guest-delivery' || suspended.kind !== 'suspended') {
    throw new Error(`unexpected worker completion at ${point}`);
  }
  const operationId = dispatched?.id;
  if (operationId === undefined)
    throw new Error('operation was not dispatched');
  await interpreter.deliver(operationId, { answer: 42 });
  await signalAndWait(operationId, lease.epoch);
}

await main();
