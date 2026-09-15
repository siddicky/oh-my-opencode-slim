import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunJournal } from './journal';
import {
  type SchedulerClock,
  SchedulerStateError,
  WorkflowScheduler,
} from './scheduler';

// allow: SIZE_OK — one integration suite owns the scheduler's persisted state matrix.
const temporaryDirectories = new Set<string>();
const KNOWN_PROVIDER_IDS = new Set([
  'fallback-provider',
  'known-provider',
  'provider',
  'provider-1',
  'provider-2',
  'provider-3',
  'provider-4',
  'provider-5',
  'provider-a',
  'provider-b',
  'provider-c',
]);

function databasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `slim-scheduler-${name}-`));
  temporaryDirectories.add(directory);
  return join(directory, 'journal.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe('workflow scheduler', () => {
  test('scheduler conjunctive admission persists project and provider limits', () => {
    const path = databasePath('conjunctive');
    const firstJournal = createBunJournal(path);
    const firstLease = firstJournal.acquireLease('project', 'scheduler-a');
    expect(firstLease).not.toBeNull();
    if (firstLease === null) return;
    const first = new WorkflowScheduler({
      clock: { now: () => 1_000, sleep: async () => undefined },
      journal: firstJournal,
      knownProviderIds: KNOWN_PROVIDER_IDS,
      lease: firstLease,
    });
    first.startRun({
      deadlineMs: 10_000,
      runId: 'run-a',
      tokenBudget: 100_000,
    });
    first.startRun({
      deadlineMs: 10_000,
      runId: 'run-b',
      tokenBudget: 100_000,
    });

    expect(
      first.admitCall(call('a-1', 'run-a', 'node-1', 'provider-a')).kind,
    ).toBe('admitted');
    expect(
      first.admitCall(call('a-2', 'run-a', 'node-2', 'provider-a')).kind,
    ).toBe('admitted');
    expect(
      first.admitCall(call('b-1', 'run-b', 'node-3', 'provider-b')).kind,
    ).toBe('admitted');
    expect(
      first.admitCall(call('a-3', 'run-a', 'node-4', 'provider-a')),
    ).toEqual({
      kind: 'blocked',
      reason: 'provider-capacity',
    });
    expect(
      first.admitCall(call('b-2', 'run-b', 'node-4', 'provider-b')).kind,
    ).toBe('admitted');
    expect(
      first.admitCall(call('c-1', 'run-b', 'node-5', 'provider-c')),
    ).toEqual({
      kind: 'blocked',
      reason: 'node-capacity',
    });

    const secondJournal = createBunJournal(path);
    expect(secondJournal.acquireLease('project', 'scheduler-b')).toBeNull();
    firstJournal.releaseLease(firstLease);
    const secondLease = secondJournal.acquireLease('project', 'scheduler-b');
    expect(secondLease).not.toBeNull();
    if (secondLease === null) return;
    const second = new WorkflowScheduler({
      clock: { now: () => 1_000, sleep: async () => undefined },
      journal: secondJournal,
      knownProviderIds: KNOWN_PROVIDER_IDS,
      lease: secondLease,
    });
    expect(
      second.admitCall(call('c-1', 'run-b', 'node-5', 'provider-c')),
    ).toEqual({
      kind: 'blocked',
      reason: 'node-capacity',
    });
    secondJournal.releaseLease(secondLease);
    secondJournal.close();
    firstJournal.close();
  });

  test('scheduler budget and nested bypass rejection persists accounting', () => {
    const path = databasePath('budget');
    const journal = createBunJournal(path);
    const lease = journal.acquireLease('project', 'scheduler-a');
    expect(lease).not.toBeNull();
    if (lease === null) return;
    const scheduler = schedulerFor(journal, lease, 1_000);
    scheduler.startRun({
      deadlineMs: 10_000,
      runId: 'run-budget',
      tokenBudget: 3_000,
    });

    expect(
      scheduler.admitCall(
        call('budget-1', 'run-budget', 'node-1', 'provider-a'),
      ).kind,
    ).toBe('admitted');
    scheduler.settleCall({
      operationId: 'budget-1',
      outcome: 'terminal',
      usage: usage(100, 200, 50, 50),
      usageIdentity: 'request-1',
    });
    expect(
      scheduler.admitCall({
        ...call('budget-2', 'run-budget', 'node-1', 'provider-a'),
        callKind: 'critic',
        role: 'critic',
      }).kind,
    ).toBe('admitted');
    scheduler.settleCall({
      operationId: 'budget-2',
      outcome: 'terminal',
      usage: usage(100, 200, 50, 50),
      usageIdentity: 'request-1',
    });

    expect(
      scheduler.admitCall({
        ...call('budget-3', 'run-budget', 'node-1', 'provider-a'),
        knownInputTokens: 1_800,
        responseAllowanceTokens: 900,
      }),
    ).toEqual({ kind: 'blocked', reason: 'budget-exhausted' });
    expect(() =>
      scheduler.startRun({
        deadlineMs: 10_000,
        runId: 'run-budget',
        tokenBudget: 4_000,
      }),
    ).toThrow('resume cannot reset run budgets');
    expect(
      scheduler.authorizeNestedDelegation({
        routedThroughSchedulerBridge: true,
        workflowOwnedSession: true,
      }),
    ).toBe('scheduler-bridge');
    expect(() =>
      scheduler.authorizeNestedDelegation({
        routedThroughSchedulerBridge: false,
        workflowOwnedSession: true,
      }),
    ).toThrow(SchedulerStateError);
    expect(
      scheduler.admitCall(
        call('unknown-provider', 'run-budget', 'node-1', 'unknown'),
      ),
    ).toEqual({ kind: 'blocked', reason: 'unknown-provider' });

    const recovered = journal.recover('project');
    const run = recovered.states.find(
      (record) => record.kind === 'run' && record.recordId === 'run-budget',
    );
    const reservation = recovered.states.find(
      (record) =>
        record.kind === 'reservation' && record.recordId === 'budget-1',
    );
    expect(run?.payload).toMatchObject({
      consumedTokens: 400,
      deadlineMs: 10_000,
      tokenBudget: 3_000,
    });
    expect(reservation?.payload).toMatchObject({
      knownInputTokens: 100,
      responseAllowanceTokens: 900,
      tokenCeiling: 1_000,
    });
    journal.releaseLease(lease);
    journal.close();
  });

  test('terminal confirmation releases provider permits and unknown usage blocks resume', () => {
    const path = databasePath('terminal');
    const firstJournal = createBunJournal(path);
    const firstLease = firstJournal.acquireLease('project', 'scheduler-a');
    expect(firstLease).not.toBeNull();
    if (firstLease === null) return;
    const first = schedulerFor(firstJournal, firstLease, 1_000);
    first.startRun({ deadlineMs: 10_000, runId: 'run', tokenBudget: 10_000 });
    expect(first.admitCall(call('op-1', 'run', 'node', 'provider')).kind).toBe(
      'admitted',
    );
    expect(first.admitCall(call('op-2', 'run', 'node', 'provider')).kind).toBe(
      'admitted',
    );
    first.settleCall({ operationId: 'op-1', outcome: 'uncertain' });
    expect(first.admitCall(call('op-3', 'run', 'node', 'provider'))).toEqual({
      kind: 'blocked',
      reason: 'provider-capacity',
    });
    first.settleCall({
      operationId: 'op-2',
      outcome: 'terminal',
      usage: 'unavailable',
      usageIdentity: 'request-2',
    });
    expect(first.admitCall(call('op-3', 'run', 'node', 'provider'))).toEqual({
      kind: 'blocked',
      reason: 'unknown-usage',
    });
    firstJournal.releaseLease(firstLease);
    firstJournal.close();

    const secondJournal = createBunJournal(path);
    const secondLease = secondJournal.acquireLease('project', 'scheduler-b');
    expect(secondLease).not.toBeNull();
    if (secondLease === null) return;
    const resumed = schedulerFor(secondJournal, secondLease, 1_000);
    resumed.startRun({ deadlineMs: 10_000, runId: 'run', tokenBudget: 10_000 });
    expect(resumed.admitCall(call('op-3', 'run', 'node', 'provider'))).toEqual({
      kind: 'blocked',
      reason: 'unknown-usage',
    });
    secondJournal.releaseLease(secondLease);
    secondJournal.close();
  });

  test('effective provider migration cannot bypass provider permits', () => {
    const { journal, lease, scheduler } = harness('provider-migration');
    scheduler.startRun({
      deadlineMs: 10_000,
      runId: 'run',
      tokenBudget: 10_000,
    });
    expect(
      scheduler.admitCall({
        ...call('fallback-1', 'run', 'node-1', 'fallback-provider'),
        plannedProviderId: 'primary-provider',
      }).kind,
    ).toBe('admitted');
    expect(
      scheduler.admitCall({
        ...call('fallback-2', 'run', 'node-2', 'fallback-provider'),
        plannedProviderId: 'other-provider',
      }).kind,
    ).toBe('admitted');
    expect(
      scheduler.admitCall({
        ...call('fallback-3', 'run', 'node-3', 'fallback-provider'),
        plannedProviderId: 'third-provider',
      }),
    ).toEqual({ kind: 'blocked', reason: 'provider-capacity' });
    journal.releaseLease(lease);
    journal.close();
  });

  test('scheduler rejects forged transitions and unconfigured providers', () => {
    const { journal, lease, scheduler } = harness('state-machine');
    scheduler.startRun({
      deadlineMs: 10_000,
      runId: 'run',
      tokenBudget: 10_000,
    });

    expect(
      scheduler.admitCall(
        call('unconfigured', 'run', 'node', 'unconfigured-provider'),
      ),
    ).toEqual({ kind: 'blocked', reason: 'unknown-provider' });
    expect(() =>
      scheduler.transitionAttempt({
        acceptedArtifact: 'sha256:forged',
        attempt: 1,
        nodeId: 'forged',
        runId: 'run',
        state: 'accepted',
      }),
    ).toThrow(SchedulerStateError);
    expect(
      scheduler.admitCall(call('active', 'run', 'node', 'provider')).kind,
    ).toBe('admitted');
    expect(() =>
      scheduler.transitionAttempt({
        acceptedArtifact: 'sha256:premature',
        attempt: 1,
        nodeId: 'node',
        runId: 'run',
        state: 'accepted',
      }),
    ).toThrow(SchedulerStateError);
    expect(() => scheduler.requestRepair('run', 'node')).toThrow(
      SchedulerStateError,
    );
    journal.releaseLease(lease);
    journal.close();
  });

  test('ready ordering waits for accepted dependency artifacts', () => {
    const { journal, lease, scheduler } = harness('ready');
    scheduler.startRun({
      deadlineMs: 10_000,
      runId: 'run',
      tokenBudget: 10_000,
    });
    const nodes = [
      { id: 'z-root', dependsOn: [], inputArtifacts: [] },
      { id: 'child', dependsOn: ['a-root'], inputArtifacts: ['spec'] },
      { id: 'a-root', dependsOn: [], inputArtifacts: [] },
      { id: 'Z-root', dependsOn: [], inputArtifacts: [] },
    ];
    expect(scheduler.readyNodeIds(nodes, new Set())).toEqual([
      'Z-root',
      'a-root',
      'z-root',
    ]);
    expect(
      scheduler.admitCall(call('root', 'run', 'a-root', 'provider')).kind,
    ).toBe('admitted');
    scheduler.settleCall({
      operationId: 'root',
      outcome: 'terminal',
      usage: usage(1, 1, 0, 0),
      usageIdentity: 'root-request',
    });
    scheduler.transitionAttempt({
      acceptedArtifact: 'sha256:accepted',
      attempt: 1,
      nodeId: 'a-root',
      runId: 'run',
      state: 'accepted',
    });
    expect(scheduler.readyNodeIds(nodes, new Set())).toEqual([
      'Z-root',
      'z-root',
    ]);
    expect(scheduler.readyNodeIds(nodes, new Set(['spec']))).toEqual([
      'Z-root',
      'z-root',
      'child',
    ]);
    journal.releaseLease(lease);
    journal.close();
  });

  test('parked continuations and expansion barriers release node capacity', () => {
    const { journal, lease, scheduler } = harness('parked');
    scheduler.startRun({
      deadlineMs: 10_000,
      runId: 'run',
      tokenBudget: 20_000,
    });
    for (let index = 1; index <= 4; index += 1) {
      const operationId = `op-${index}`;
      expect(
        scheduler.admitCall(
          call(operationId, 'run', `node-${index}`, `provider-${index}`),
        ).kind,
      ).toBe('admitted');
      scheduler.settleCall({
        operationId,
        outcome: 'terminal',
        usage: usage(1, 1, 0, 0),
        usageIdentity: `request-${index}`,
      });
    }
    expect(
      scheduler.admitCall(call('blocked', 'run', 'node-5', 'provider-5')),
    ).toEqual({
      kind: 'blocked',
      reason: 'node-capacity',
    });
    scheduler.transitionAttempt({
      attempt: 1,
      nodeId: 'node-1',
      runId: 'run',
      state: 'parked',
    });
    expect(
      scheduler.admitCall(call('unblocked', 'run', 'node-5', 'provider-5'))
        .kind,
    ).toBe('admitted');
    journal.releaseLease(lease);
    journal.close();
  });

  test('repair rounds persist and stop after three', () => {
    const path = databasePath('repairs');
    const firstJournal = createBunJournal(path);
    const firstLease = firstJournal.acquireLease('project', 'scheduler-a');
    expect(firstLease).not.toBeNull();
    if (firstLease === null) return;
    const first = schedulerFor(firstJournal, firstLease, 1_000);
    first.startRun({ deadlineMs: 10_000, runId: 'run', tokenBudget: 10_000 });
    failNodeAttempt(first, 1);
    expect(first.requestRepair('run', 'node')).toBe(1);
    failNodeAttempt(first, 2);
    expect(first.requestRepair('run', 'node')).toBe(2);
    firstJournal.releaseLease(firstLease);
    firstJournal.close();

    const secondJournal = createBunJournal(path);
    const secondLease = secondJournal.acquireLease('project', 'scheduler-b');
    expect(secondLease).not.toBeNull();
    if (secondLease === null) return;
    const second = schedulerFor(secondJournal, secondLease, 1_000);
    failNodeAttempt(second, 3);
    expect(second.requestRepair('run', 'node')).toBe(3);
    failNodeAttempt(second, 4);
    expect(second.requestRepair('run', 'node')).toBeUndefined();
    secondJournal.releaseLease(secondLease);
    secondJournal.close();
  });

  test('node attempt sequence cannot reset after resume', () => {
    const path = databasePath('attempt-resume');
    const firstJournal = createBunJournal(path);
    const firstLease = firstJournal.acquireLease('project', 'scheduler-a');
    expect(firstLease).not.toBeNull();
    if (firstLease === null) return;
    const first = schedulerFor(firstJournal, firstLease, 1_000);
    first.startRun({ deadlineMs: 10_000, runId: 'run', tokenBudget: 10_000 });
    expect(
      first.admitCall(call('attempt-1', 'run', 'node', 'provider')).kind,
    ).toBe('admitted');
    first.settleCall({
      operationId: 'attempt-1',
      outcome: 'terminal',
      usage: usage(1, 1, 0, 0),
      usageIdentity: 'attempt-request-1',
    });
    first.transitionAttempt({
      attempt: 1,
      nodeId: 'node',
      runId: 'run',
      state: 'failed',
    });
    firstJournal.releaseLease(firstLease);
    firstJournal.close();

    const secondJournal = createBunJournal(path);
    const secondLease = secondJournal.acquireLease('project', 'scheduler-b');
    expect(secondLease).not.toBeNull();
    if (secondLease === null) return;
    const second = schedulerFor(secondJournal, secondLease, 1_000);
    expect(second.admitCall(call('reset', 'run', 'node', 'provider'))).toEqual({
      kind: 'blocked',
      reason: 'attempt-sequence',
    });
    expect(
      second.admitCall({
        ...call('attempt-2', 'run', 'node', 'provider'),
        attempt: 2,
        callKind: 'repair',
      }).kind,
    ).toBe('admitted');
    secondJournal.releaseLease(secondLease);
    secondJournal.close();
  });

  test('transport retry backoff is bounded and ambiguous writes are uncertain', async () => {
    let now = 1_000;
    const delays: number[] = [];
    const { journal, lease, scheduler } = harness('transport', {
      now: () => now,
      sleep: async (delay) => {
        delays.push(delay);
        now += delay;
      },
    });
    let attempts = 0;
    const exhausted = await scheduler.executeTransport({
      attempt: async () => {
        attempts += 1;
        return { kind: 'confirmed-pre-admission-failure' };
      },
      deadlineMs: 2_500,
      kind: 'pre-admission',
    });
    expect(exhausted).toEqual({ kind: 'exhausted' });
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000, 500]);

    now = 1_000;
    delays.length = 0;
    attempts = 0;
    const succeeded = await scheduler.executeTransport({
      attempt: async () => {
        attempts += 1;
        return attempts === 3
          ? { kind: 'success', value: 'done' }
          : { kind: 'confirmed-pre-admission-failure' };
      },
      deadlineMs: 10_000,
      kind: 'idempotent-read',
    });
    expect(succeeded).toEqual({ kind: 'success', value: 'done' });
    expect(delays).toEqual([1_000, 2_000]);

    now = 1_000;
    delays.length = 0;
    attempts = 0;
    const safeWrite = await scheduler.executeTransport({
      attempt: async () => {
        attempts += 1;
        return attempts === 2
          ? { kind: 'success', value: 'created' }
          : { kind: 'confirmed-pre-admission-failure' };
      },
      deadlineMs: 10_000,
      kind: 'mutation-write',
    });
    expect(safeWrite).toEqual({ kind: 'success', value: 'created' });
    expect(delays).toEqual([1_000]);

    now = 1_000;
    delays.length = 0;
    attempts = 0;
    const safeRead = await scheduler.executeTransport({
      attempt: async () => {
        attempts += 1;
        return attempts === 2
          ? { kind: 'success', value: 'read' }
          : { kind: 'ambiguous' };
      },
      deadlineMs: 10_000,
      kind: 'idempotent-read',
    });
    expect(safeRead).toEqual({ kind: 'success', value: 'read' });
    expect(delays).toEqual([1_000]);

    attempts = 0;
    const uncertain = await scheduler.executeTransport({
      attempt: async () => {
        attempts += 1;
        return { kind: 'ambiguous' };
      },
      deadlineMs: 10_000,
      kind: 'mutation-write',
    });
    expect(uncertain).toEqual({ kind: 'uncertain' });
    expect(attempts).toBe(1);
    journal.releaseLease(lease);
    journal.close();
  });

  test('absolute deadline is not renewed on resume', () => {
    const path = databasePath('deadline');
    const firstJournal = createBunJournal(path);
    const firstLease = firstJournal.acquireLease('project', 'scheduler-a');
    expect(firstLease).not.toBeNull();
    if (firstLease === null) return;
    schedulerFor(firstJournal, firstLease, 1_000).startRun({
      deadlineMs: 2_000,
      runId: 'run',
      tokenBudget: 10_000,
    });
    firstJournal.releaseLease(firstLease);
    firstJournal.close();

    const secondJournal = createBunJournal(path);
    const secondLease = secondJournal.acquireLease('project', 'scheduler-b');
    expect(secondLease).not.toBeNull();
    if (secondLease === null) return;
    const resumed = schedulerFor(secondJournal, secondLease, 2_000);
    resumed.startRun({ deadlineMs: 2_000, runId: 'run', tokenBudget: 10_000 });
    expect(resumed.admitCall(call('late', 'run', 'node', 'provider'))).toEqual({
      kind: 'blocked',
      reason: 'deadline-exhausted',
    });
    secondJournal.releaseLease(secondLease);
    secondJournal.close();
  });
});

function call(
  operationId: string,
  runId: string,
  nodeId: string,
  providerId: string,
) {
  return {
    attempt: 1,
    callKind: 'executor' as const,
    knownInputTokens: 100,
    nodeId,
    operationId,
    providerId,
    role: 'executor' as const,
    responseAllowanceTokens: 900,
    runId,
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cachedTokens: number,
) {
  return { cachedTokens, inputTokens, outputTokens, reasoningTokens };
}

function failNodeAttempt(scheduler: WorkflowScheduler, attempt: number): void {
  const operationId = `repair-${attempt}`;
  expect(
    scheduler.admitCall({
      ...call(operationId, 'run', 'node', 'provider'),
      attempt,
      callKind: attempt === 1 ? 'executor' : 'repair',
    }).kind,
  ).toBe('admitted');
  scheduler.settleCall({
    operationId,
    outcome: 'terminal',
    usage: usage(1, 1, 0, 0),
    usageIdentity: `repair-request-${attempt}`,
  });
  scheduler.transitionAttempt({
    attempt,
    nodeId: 'node',
    runId: 'run',
    state: 'failed',
  });
}

function schedulerFor(
  journal: ReturnType<typeof createBunJournal>,
  lease: NonNullable<ReturnType<typeof journal.acquireLease>>,
  now: number,
): WorkflowScheduler {
  return new WorkflowScheduler({
    clock: { now: () => now, sleep: async () => undefined },
    journal,
    knownProviderIds: KNOWN_PROVIDER_IDS,
    lease,
  });
}

function harness(name: string, clock?: SchedulerClock) {
  const journal = createBunJournal(databasePath(name));
  const lease = journal.acquireLease('project', 'scheduler');
  if (lease === null) throw new SchedulerStateError('test lease unavailable');
  return {
    journal,
    lease,
    scheduler: new WorkflowScheduler({
      clock: clock ?? { now: () => 1_000, sleep: async () => undefined },
      journal,
      knownProviderIds: KNOWN_PROVIDER_IDS,
      lease,
    }),
  };
}
