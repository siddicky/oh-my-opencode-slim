import { z } from 'zod';
import {
  budgetBlockReason,
  incrementRepairRound,
  initialRunState,
  readReservations,
  readRunState,
  reconcileUsage,
  type SchedulerReservation,
  SchedulerReservationSchema,
} from './budgets';
import { WORKFLOW_LIMITS } from './config';
import type { UsageReport, WorkflowRole } from './contracts';
import type { JournalLease, WorkflowJournal } from './journal';

// allow: SIZE_OK — journal admission and transition invariants form one state machine.
export interface SchedulerClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export type AdmissionResult =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'budget-exhausted'
        | 'deadline-exhausted'
        | 'attempt-sequence'
        | 'node-capacity'
        | 'provider-capacity'
        | 'unknown-provider'
        | 'unknown-run'
        | 'unknown-usage';
    };

export type TransportResult<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'exhausted' };

type TransportAttempt<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'confirmed-pre-admission-failure' }
  | { readonly kind: 'ambiguous' };

type SchedulerNode = {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly inputArtifacts: readonly string[];
};

const AttemptStateSchema = z
  .object({
    recordType: z.literal('scheduler-node-attempt'),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    attempt: z.number().int().positive(),
    state: z.enum(['active', 'parked', 'accepted', 'failed', 'uncertain']),
    acceptedArtifact: z.string().min(1).optional(),
  })
  .strict();

type AttemptState = z.infer<typeof AttemptStateSchema>;

export class SchedulerStateError extends Error {
  readonly name = 'SchedulerStateError';
}

export class WorkflowScheduler {
  private readonly journal: WorkflowJournal;
  private readonly lease: JournalLease;
  private readonly clock: SchedulerClock;
  private readonly knownProviderIds: ReadonlySet<string>;

  constructor(options: {
    readonly journal: WorkflowJournal;
    readonly lease: JournalLease;
    readonly clock: SchedulerClock;
    readonly knownProviderIds: ReadonlySet<string>;
  }) {
    this.journal = options.journal;
    this.lease = options.lease;
    this.clock = options.clock;
    this.knownProviderIds = options.knownProviderIds;
  }

  startRun(input: {
    readonly runId: string;
    readonly tokenBudget: number;
    readonly deadlineMs: number;
  }): void {
    const snapshot = this.journal.recover(this.lease.projectId);
    const existing = readRunState(snapshot, input.runId);
    if (existing !== undefined) {
      if (
        existing.tokenBudget !== input.tokenBudget ||
        existing.deadlineMs !== input.deadlineMs
      ) {
        throw new SchedulerStateError('resume cannot reset run budgets');
      }
      return;
    }
    const run = initialRunState(input);
    this.journal.transaction(this.lease, (transaction) => {
      transaction.persistState('run', input.runId, run);
    });
  }

  admitCall(input: {
    readonly operationId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly callKind: 'executor' | 'critic' | 'debugger' | 'repair';
    readonly role: WorkflowRole;
    readonly providerId: string;
    readonly plannedProviderId?: string;
    readonly knownInputTokens: number;
    readonly responseAllowanceTokens: number;
  }): AdmissionResult {
    const snapshot = this.journal.recover(this.lease.projectId);
    if (
      snapshot.operations.some(
        (operation) => operation.operationId === input.operationId,
      )
    ) {
      return { kind: 'duplicate' };
    }
    const run = readRunState(snapshot, input.runId);
    if (run === undefined) return { kind: 'blocked', reason: 'unknown-run' };
    if (!this.knownProviderIds.has(input.providerId)) {
      return { kind: 'blocked', reason: 'unknown-provider' };
    }
    const reservations = readReservations(snapshot);
    const attempts = readAttempts(snapshot.states);
    const attemptId = `${input.runId}:${input.nodeId}:${input.attempt}`;
    const currentAttempt = attempts.find(
      (attempt) => attemptIdFor(attempt) === attemptId,
    );
    const latestAttempt = attempts
      .filter(
        (attempt) =>
          attempt.runId === input.runId && attempt.nodeId === input.nodeId,
      )
      .reduce((latest, attempt) => Math.max(latest, attempt.attempt), 0);
    const resumesCurrentAttempt =
      currentAttempt?.state === 'active' || currentAttempt?.state === 'parked';
    if (!resumesCurrentAttempt && input.attempt !== latestAttempt + 1) {
      return { kind: 'blocked', reason: 'attempt-sequence' };
    }
    if (
      currentAttempt?.state !== 'active' &&
      attempts.filter((attempt) => attempt.state === 'active').length >=
        WORKFLOW_LIMITS.maxActiveNodeAttempts
    ) {
      return { kind: 'blocked', reason: 'node-capacity' };
    }
    if (
      reservations.filter(
        (reservation) =>
          reservation.providerId === input.providerId &&
          reservation.status !== 'terminal',
      ).length >= WORKFLOW_LIMITS.maxActiveModelCallsPerProvider
    ) {
      return { kind: 'blocked', reason: 'provider-capacity' };
    }
    const tokenCeiling = input.knownInputTokens + input.responseAllowanceTokens;
    const nowMs = this.clock.now();
    const budgetReason = budgetBlockReason({
      nowMs,
      requestedTokens: tokenCeiling,
      reservations,
      run,
    });
    if (budgetReason !== undefined) {
      return { kind: 'blocked', reason: budgetReason };
    }
    const reservation = SchedulerReservationSchema.parse({
      ...input,
      recordType: 'scheduler-reservation',
      reservedAtMs: nowMs,
      status: 'active',
      tokenCeiling,
    });
    let claimed = false;
    this.journal.transaction(this.lease, (transaction) => {
      claimed = transaction.persistEffect(input.operationId, {
        kind: 'dispatch-intent',
        ...input,
        tokenCeiling,
      });
      if (!claimed) return;
      transaction.persistState('reservation', input.operationId, reservation);
      transaction.persistState(
        'node-attempt',
        attemptId,
        AttemptStateSchema.parse({
          recordType: 'scheduler-node-attempt',
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
          state: 'active',
        }),
      );
    });
    return claimed ? { kind: 'admitted' } : { kind: 'duplicate' };
  }

  settleCall(input: {
    readonly operationId: string;
    readonly outcome: 'terminal' | 'uncertain';
    readonly usageIdentity?: string;
    readonly usage?: UsageReport | 'unavailable';
  }): void {
    const snapshot = this.journal.recover(this.lease.projectId);
    const reservation = readReservations(snapshot).find(
      (candidate) => candidate.operationId === input.operationId,
    );
    if (reservation === undefined) {
      throw new SchedulerStateError('cannot settle an unknown reservation');
    }
    if (reservation.status === 'terminal') return;
    if (input.outcome === 'uncertain') {
      this.persistReservation({ ...reservation, status: 'uncertain' });
      return;
    }
    if (input.usageIdentity === undefined || input.usage === undefined) {
      throw new SchedulerStateError(
        'terminal calls require authoritative usage',
      );
    }
    const run = readRunState(snapshot, reservation.runId);
    if (run === undefined)
      throw new SchedulerStateError('run state is missing');
    const reconciled = reconcileUsage({
      run,
      usage: input.usage,
      usageIdentity: input.usageIdentity,
    });
    this.journal.transaction(this.lease, (transaction) => {
      transaction.persistState('run', run.runId, reconciled);
      transaction.persistState('reservation', reservation.operationId, {
        ...reservation,
        status: 'terminal',
        terminalAtMs: this.clock.now(),
        usageIdentity: input.usageIdentity,
        ...(input.usage === 'unavailable' ? {} : { usage: input.usage }),
      });
      transaction.persistResult(input.operationId, { outcome: 'terminal' });
    });
  }

  transitionAttempt(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly state: 'parked' | 'accepted' | 'failed' | 'uncertain';
    readonly acceptedArtifact?: string;
  }): void {
    const snapshot = this.journal.recover(this.lease.projectId);
    const attempt = readAttempts(snapshot.states).find(
      (candidate) =>
        candidate.runId === input.runId &&
        candidate.nodeId === input.nodeId &&
        candidate.attempt === input.attempt,
    );
    if (attempt === undefined) {
      throw new SchedulerStateError('cannot transition an unknown attempt');
    }
    if (attempt.state !== 'active') {
      throw new SchedulerStateError('attempt transition requires active state');
    }
    const activeCalls = readReservations(snapshot).filter(
      (reservation) =>
        reservation.runId === input.runId &&
        reservation.nodeId === input.nodeId &&
        reservation.attempt === input.attempt &&
        reservation.status !== 'terminal',
    );
    if (input.state === 'parked' && activeCalls.length > 0) {
      throw new SchedulerStateError(
        'parked attempts cannot hold provider permits',
      );
    }
    if (input.state !== 'uncertain' && activeCalls.length > 0) {
      throw new SchedulerStateError(
        'terminal attempt transitions require confirmed call outcomes',
      );
    }
    if (input.state === 'accepted' && input.acceptedArtifact === undefined) {
      throw new SchedulerStateError('accepted attempts require an artifact');
    }
    const state = AttemptStateSchema.parse({
      recordType: 'scheduler-node-attempt',
      ...input,
    });
    this.journal.transaction(this.lease, (transaction) => {
      transaction.persistState('node-attempt', attemptIdFor(state), state);
    });
  }

  requestRepair(runId: string, nodeId: string): number | undefined {
    const snapshot = this.journal.recover(this.lease.projectId);
    const run = readRunState(snapshot, runId);
    if (run === undefined)
      throw new SchedulerStateError('run state is missing');
    const latestAttempt = readAttempts(snapshot.states)
      .filter((attempt) => attempt.runId === runId && attempt.nodeId === nodeId)
      .reduce<AttemptState | undefined>(
        (latest, attempt) =>
          latest === undefined || attempt.attempt > latest.attempt
            ? attempt
            : latest,
        undefined,
      );
    const repairRounds = run.repairRoundsByNode[nodeId] ?? 0;
    if (
      latestAttempt?.state !== 'failed' ||
      latestAttempt.attempt !== repairRounds + 1
    ) {
      throw new SchedulerStateError(
        'repair requires the preceding failed node attempt',
      );
    }
    const updated = incrementRepairRound(run, nodeId);
    if (updated === undefined) return undefined;
    this.journal.transaction(this.lease, (transaction) => {
      transaction.persistState('run', runId, updated);
    });
    return updated.repairRoundsByNode[nodeId];
  }

  readyNodeIds(
    nodes: readonly SchedulerNode[],
    acceptedInputArtifacts: ReadonlySet<string>,
  ): readonly string[] {
    const attempts = readAttempts(
      this.journal.recover(this.lease.projectId).states,
    );
    const accepted = new Set(
      attempts
        .filter(
          (attempt) =>
            attempt.state === 'accepted' &&
            attempt.acceptedArtifact !== undefined,
        )
        .map((attempt) => attempt.nodeId),
    );
    const started = new Set(
      attempts
        .filter((attempt) => attempt.state !== 'failed')
        .map((attempt) => attempt.nodeId),
    );
    return [...nodes]
      .filter(
        (node) =>
          !started.has(node.id) &&
          node.dependsOn.every((dependency) => accepted.has(dependency)) &&
          node.inputArtifacts.every((artifact) =>
            acceptedInputArtifacts.has(artifact),
          ),
      )
      .sort(
        (left, right) =>
          topologicalRank(left, nodes) - topologicalRank(right, nodes) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map((node) => node.id);
  }

  authorizeNestedDelegation(input: {
    readonly workflowOwnedSession: boolean;
    readonly routedThroughSchedulerBridge: boolean;
  }): 'allowed' | 'scheduler-bridge' {
    if (!input.workflowOwnedSession) return 'allowed';
    if (input.routedThroughSchedulerBridge) return 'scheduler-bridge';
    throw new SchedulerStateError(
      'workflow-owned nested delegation must use the scheduler bridge',
    );
  }

  async executeTransport<T>(input: {
    readonly kind: 'idempotent-read' | 'pre-admission' | 'mutation-write';
    readonly deadlineMs: number;
    readonly attempt: () => Promise<TransportAttempt<T>>;
  }): Promise<TransportResult<T>> {
    for (
      let attempt = 0;
      attempt <= WORKFLOW_LIMITS.maxTransportRetries;
      attempt += 1
    ) {
      if (this.clock.now() >= input.deadlineMs) {
        return { kind: 'exhausted' };
      }
      const result = await input.attempt();
      switch (result.kind) {
        case 'success':
          return result;
        case 'confirmed-pre-admission-failure':
          break;
        case 'ambiguous':
          if (input.kind !== 'idempotent-read') {
            return { kind: 'uncertain' };
          }
          break;
        default:
          return assertNever(result);
      }
      if (attempt === WORKFLOW_LIMITS.maxTransportRetries) break;
      const remaining = input.deadlineMs - this.clock.now();
      if (remaining <= 0) return { kind: 'exhausted' };
      await this.clock.sleep(Math.min(1_000 * 2 ** attempt, remaining));
    }
    return { kind: 'exhausted' };
  }

  private persistReservation(reservation: SchedulerReservation): void {
    this.journal.transaction(this.lease, (transaction) => {
      transaction.persistState(
        'reservation',
        reservation.operationId,
        reservation,
      );
    });
  }
}

function assertNever(value: never): never {
  throw new SchedulerStateError(`unexpected scheduler variant: ${value}`);
}

function readAttempts(
  states: ReturnType<WorkflowJournal['recover']>['states'],
): readonly AttemptState[] {
  return states
    .filter((record) => record.kind === 'node-attempt')
    .map((record) => {
      const parsed = AttemptStateSchema.safeParse(record.payload);
      if (!parsed.success) {
        throw new SchedulerStateError(
          `invalid node attempt: ${record.recordId}`,
        );
      }
      return parsed.data;
    });
}

function attemptIdFor(attempt: AttemptState): string {
  return `${attempt.runId}:${attempt.nodeId}:${attempt.attempt}`;
}

function topologicalRank(
  node: SchedulerNode,
  nodes: readonly SchedulerNode[],
  visiting = new Set<string>(),
): number {
  if (node.dependsOn.length === 0) return 0;
  if (visiting.has(node.id)) throw new SchedulerStateError('cyclic node graph');
  visiting.add(node.id);
  let rank = 0;
  for (const dependencyId of node.dependsOn) {
    const dependency = nodes.find((candidate) => candidate.id === dependencyId);
    if (dependency === undefined) {
      throw new SchedulerStateError(`unknown dependency: ${dependencyId}`);
    }
    rank = Math.max(rank, topologicalRank(dependency, nodes, visiting) + 1);
  }
  visiting.delete(node.id);
  return rank;
}
