import { z } from 'zod';
import { type UsageReport, WORKFLOW_ROLE_NAMES } from './contracts';
import type { JournalSnapshot } from './journal';

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
  })
  .strict();

export const SchedulerRunStateSchema = z
  .object({
    recordType: z.literal('scheduler-run'),
    runId: z.string().min(1),
    tokenBudget: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    consumedTokens: z.number().int().nonnegative(),
    usageKnown: z.boolean(),
    usageByIdentity: z.record(z.string(), UsageSchema),
    repairRoundsByNode: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export type SchedulerRunState = z.infer<typeof SchedulerRunStateSchema>;

export const SchedulerReservationSchema = z
  .object({
    recordType: z.literal('scheduler-reservation'),
    operationId: z.string().min(1),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    attempt: z.number().int().positive(),
    callKind: z.enum(['executor', 'critic', 'debugger', 'repair']),
    role: z.enum(WORKFLOW_ROLE_NAMES),
    providerId: z.string().min(1),
    plannedProviderId: z.string().min(1).optional(),
    knownInputTokens: z.number().int().nonnegative(),
    responseAllowanceTokens: z.number().int().positive(),
    tokenCeiling: z.number().int().positive(),
    reservedAtMs: z.number().int().nonnegative(),
    status: z.enum(['active', 'uncertain', 'terminal']),
    terminalAtMs: z.number().int().nonnegative().optional(),
    usageIdentity: z.string().min(1).optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export type SchedulerReservation = z.infer<typeof SchedulerReservationSchema>;

export type BudgetBlockReason =
  | 'budget-exhausted'
  | 'deadline-exhausted'
  | 'unknown-usage';

export class SchedulerBudgetStateError extends Error {
  readonly name = 'SchedulerBudgetStateError';

  constructor(readonly recordId: string) {
    super(`invalid persisted scheduler budget state: ${recordId}`);
  }
}

export function initialRunState(input: {
  readonly runId: string;
  readonly tokenBudget: number;
  readonly deadlineMs: number;
}): SchedulerRunState {
  return SchedulerRunStateSchema.parse({
    recordType: 'scheduler-run',
    runId: input.runId,
    tokenBudget: input.tokenBudget,
    deadlineMs: input.deadlineMs,
    consumedTokens: 0,
    usageKnown: true,
    usageByIdentity: {},
    repairRoundsByNode: {},
  });
}

export function readRunState(
  snapshot: JournalSnapshot,
  runId: string,
): SchedulerRunState | undefined {
  const record = snapshot.states.find(
    (candidate) => candidate.kind === 'run' && candidate.recordId === runId,
  );
  if (record === undefined) return undefined;
  const parsed = SchedulerRunStateSchema.safeParse(record.payload);
  if (!parsed.success) throw new SchedulerBudgetStateError(record.recordId);
  return parsed.data;
}

export function readReservations(
  snapshot: JournalSnapshot,
): readonly SchedulerReservation[] {
  return snapshot.states
    .filter((record) => record.kind === 'reservation')
    .map((record) => {
      const parsed = SchedulerReservationSchema.safeParse(record.payload);
      if (!parsed.success) throw new SchedulerBudgetStateError(record.recordId);
      return parsed.data;
    });
}

export function budgetBlockReason(input: {
  readonly run: SchedulerRunState;
  readonly reservations: readonly SchedulerReservation[];
  readonly requestedTokens: number;
  readonly nowMs: number;
}): BudgetBlockReason | undefined {
  if (!input.run.usageKnown) return 'unknown-usage';
  if (input.nowMs >= input.run.deadlineMs) return 'deadline-exhausted';
  const reserved = input.reservations
    .filter(
      (reservation) =>
        reservation.runId === input.run.runId &&
        reservation.status !== 'terminal',
    )
    .reduce((total, reservation) => total + reservation.tokenCeiling, 0);
  return input.run.consumedTokens + reserved + input.requestedTokens >
    input.run.tokenBudget
    ? 'budget-exhausted'
    : undefined;
}

export function reconcileUsage(input: {
  readonly run: SchedulerRunState;
  readonly usageIdentity: string;
  readonly usage: UsageReport | 'unavailable';
}): SchedulerRunState {
  if (input.usage === 'unavailable') {
    return { ...input.run, usageKnown: false };
  }
  if (input.run.usageByIdentity[input.usageIdentity] !== undefined) {
    return input.run;
  }
  const usage = UsageSchema.parse(input.usage);
  const consumed =
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    usage.cachedTokens;
  return SchedulerRunStateSchema.parse({
    ...input.run,
    consumedTokens: input.run.consumedTokens + consumed,
    usageByIdentity: {
      ...input.run.usageByIdentity,
      [input.usageIdentity]: usage,
    },
  });
}

export function incrementRepairRound(
  run: SchedulerRunState,
  nodeId: string,
): SchedulerRunState | undefined {
  const current = run.repairRoundsByNode[nodeId] ?? 0;
  if (current >= 3) return undefined;
  return SchedulerRunStateSchema.parse({
    ...run,
    repairRoundsByNode: {
      ...run.repairRoundsByNode,
      [nodeId]: current + 1,
    },
  });
}
