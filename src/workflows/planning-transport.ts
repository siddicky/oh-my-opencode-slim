import { WORKFLOW_LIMITS } from './config';
import type {
  NativeDispatchResult,
  NativeSessionPort,
  NativeSessionRequest,
} from './runtime/port';

export type PlanningBudget = {
  readonly tokenBudget: number;
  readonly timeBudgetMs: number;
  readonly knownInputTokens: number;
  readonly responseAllowanceTokens: number;
};

export interface WorkflowOutputReader {
  read(operationId: string, sessionID: string): Promise<string>;
}

export type PlanningTransport = {
  readonly port: NativeSessionPort;
  readonly outputReader: WorkflowOutputReader;
  readonly budget: PlanningBudget;
  readonly now: () => number;
  readonly deadlineMs: number;
  spentTokens: number;
};

export class PlanningTransportError extends Error {
  readonly name = 'PlanningTransportError';

  constructor(
    readonly code: 'budget_exhausted' | 'transport_failed',
    message: string,
  ) {
    super(message);
  }
}

function assertNever(value: never): never {
  throw new PlanningTransportError(
    'transport_failed',
    `unexpected dispatch result: ${value}`,
  );
}

function assertBudget(transport: PlanningTransport): void {
  const reserved =
    transport.budget.knownInputTokens +
    transport.budget.responseAllowanceTokens;
  if (transport.now() > transport.deadlineMs) {
    throw new PlanningTransportError(
      'budget_exhausted',
      'planning deadline exceeded',
    );
  }
  if (transport.spentTokens + reserved > transport.budget.tokenBudget) {
    throw new PlanningTransportError(
      'budget_exhausted',
      'planning token budget exceeded',
    );
  }
}

async function resolveDispatch(
  transport: PlanningTransport,
  request: NativeSessionRequest,
): Promise<Extract<NativeDispatchResult, { readonly state: 'prompted' }>> {
  await transport.port.assertUnattendedReady(request.operationId);
  for (
    let attempt = 0;
    attempt <= WORKFLOW_LIMITS.maxTransportRetries;
    attempt += 1
  ) {
    const result = await transport.port.dispatch(request);
    switch (result.state) {
      case 'prompted':
        return result;
      case 'uncertain': {
        const reconciliation = await transport.port.reconcile(
          request.operationId,
        );
        if (reconciliation === 'found' && result.sessionID !== undefined) {
          return { state: 'prompted', sessionID: result.sessionID };
        }
        if (reconciliation !== 'missing') {
          throw new PlanningTransportError(
            'transport_failed',
            `planning transport is ${reconciliation}`,
          );
        }
        break;
      }
      default:
        return assertNever(result);
    }
  }
  throw new PlanningTransportError(
    'transport_failed',
    `planning transport retry limit reached for ${request.operationId}`,
  );
}

export async function runPlanningModelCall(
  transport: PlanningTransport,
  request: NativeSessionRequest,
): Promise<string> {
  assertBudget(transport);
  const dispatch = await resolveDispatch(transport, request);
  const outcome = await transport.port.wait(request.operationId);
  if (outcome !== 'terminal') {
    throw new PlanningTransportError(
      'transport_failed',
      `planning operation ${request.operationId} ended ${outcome}`,
    );
  }
  const usage = await transport.port.usage(request.operationId);
  transport.spentTokens +=
    usage === 'unavailable'
      ? transport.budget.knownInputTokens +
        transport.budget.responseAllowanceTokens
      : usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
  if (
    transport.spentTokens > transport.budget.tokenBudget ||
    transport.now() > transport.deadlineMs
  ) {
    throw new PlanningTransportError(
      'budget_exhausted',
      'planning budget exhausted by completed call',
    );
  }
  return transport.outputReader.read(request.operationId, dispatch.sessionID);
}
