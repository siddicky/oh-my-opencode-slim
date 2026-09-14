import { createHash } from 'node:crypto';

import { z } from 'zod';

import { WORKFLOW_LIMITS } from './config';
import type { ExpansionEnvelope } from './graph';
import { type CompiledWorkflow, compileWorkflow } from './graph';
import {
  type PlanningBudget,
  type PlanningTransport,
  runPlanningModelCall,
  type WorkflowOutputReader,
} from './planning-transport';
import { canonicalDigest, type WorkflowRoleProfile } from './profiles';
import type {
  NativeSessionPort,
  NativeSessionRequest,
  NativeWorkspaceIdentity,
} from './runtime/port';

export type {
  PlanningBudget,
  WorkflowOutputReader,
} from './planning-transport';

export type RalplanInput = {
  readonly planId: string;
  readonly parentSessionID: string;
  readonly specText: string;
  readonly specSha256: string;
  readonly source: 'deep-interview' | 'user-spec';
  readonly baseCommit: string;
  readonly plannerProfile: WorkflowRoleProfile;
  readonly criticProfile: WorkflowRoleProfile;
  readonly capabilityDigest: string;
  readonly workspace: NativeWorkspaceIdentity;
  readonly expansionEnvelope: ExpansionEnvelope;
  readonly budget: PlanningBudget;
  readonly port: NativeSessionPort;
  readonly outputReader: WorkflowOutputReader;
  readonly now?: () => number;
};

export type CriticResult = {
  readonly verdict: 'accept' | 'revise' | 'blocked';
  readonly findings: readonly string[];
  readonly artifactDigest: string;
};

type PlanBinding = {
  readonly specSha256: string;
  readonly source: RalplanInput['source'];
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly plannerProfileDigest: string;
  readonly criticProfileDigest: string;
  readonly capabilityDigest: string;
  readonly reviewerAgent: string;
};

export type RalplanResult = {
  readonly compiled: CompiledWorkflow;
  readonly review: CriticResult;
  readonly repairRounds: number;
  readonly approvalDigest: string;
  readonly binding: PlanBinding;
};

const CriticResultSchema = z
  .object({
    verdict: z.enum(['accept', 'revise', 'blocked']),
    findings: z.array(z.string().trim().min(1)),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export class PlanningError extends Error {
  readonly name = 'PlanningError';

  constructor(
    readonly code:
      | 'blocked'
      | 'critic_artifact_mismatch'
      | 'independence_required'
      | 'repair_exhausted'
      | 'spec_changed',
    message: string,
  ) {
    super(message);
  }
}

function assertNever(value: never): never {
  throw new PlanningError('blocked', `unexpected critic verdict: ${value}`);
}

function nativeRequest(
  input: RalplanInput,
  operationId: string,
  profile: WorkflowRoleProfile,
  prompt: string,
): NativeSessionRequest {
  return {
    operationId,
    parentSessionID: input.parentSessionID,
    workspace: input.workspace,
    profile: { agent: profile.agent, model: profile.model },
    prompt,
  };
}

function planBinding(input: RalplanInput): PlanBinding {
  return {
    specSha256: input.specSha256,
    source: input.source,
    projectRoot: input.workspace.canonical,
    baseCommit: input.baseCommit,
    plannerProfileDigest: input.plannerProfile.digest,
    criticProfileDigest: input.criticProfile.digest,
    capabilityDigest: input.capabilityDigest,
    reviewerAgent: input.criticProfile.agent,
  };
}

export function computePlanApprovalDigest(
  plan: Pick<RalplanResult, 'binding' | 'compiled' | 'review'>,
): string {
  return canonicalDigest({
    planId: plan.compiled.definition.planId,
    definitionDigest: plan.compiled.definitionDigest,
    policyDigest: plan.compiled.policyDigest,
    markdownDigest: plan.compiled.markdownDigest,
    expansionEnvelope: plan.compiled.expansionEnvelope,
    binding: plan.binding,
    review: plan.review,
  });
}

function assertInput(input: RalplanInput): void {
  const exactSpecHash = createHash('sha256')
    .update(Buffer.from(input.specText, 'utf8'))
    .digest('hex');
  if (exactSpecHash !== input.specSha256) {
    throw new PlanningError('spec_changed', 'finalized spec bytes changed');
  }
  if (
    input.plannerProfile.role !== 'planner' ||
    input.criticProfile.role !== 'critic' ||
    input.plannerProfile.digest === input.criticProfile.digest ||
    input.plannerProfile.agent === input.criticProfile.agent
  ) {
    throw new PlanningError(
      'independence_required',
      'planner and critic must use independent native profiles',
    );
  }
}

export async function runRalplan(input: RalplanInput): Promise<RalplanResult> {
  assertInput(input);
  const now = input.now ?? Date.now;
  const transport: PlanningTransport = {
    port: input.port,
    outputReader: input.outputReader,
    budget: input.budget,
    now,
    deadlineMs: now() + input.budget.timeBudgetMs,
    spentTokens: 0,
  };
  let repairRounds = 0;
  let findings: readonly string[] = [];

  while (true) {
    const plannerOperation = `${input.planId}:planner:${repairRounds}`;
    const plannerOutput = await runPlanningModelCall(
      transport,
      nativeRequest(
        input,
        plannerOperation,
        input.plannerProfile,
        JSON.stringify({
          kind: repairRounds === 0 ? 'plan' : 'repair',
          planId: input.planId,
          spec: input.specText,
          findings,
        }),
      ),
    );
    const compiled = compileWorkflow(
      JSON.parse(plannerOutput),
      input.expansionEnvelope,
    );
    if (compiled.definition.planId !== input.planId) {
      throw new PlanningError(
        'critic_artifact_mismatch',
        'planner returned a different plan ID',
      );
    }

    const criticOperation = `${input.planId}:critic:${repairRounds}`;
    const criticOutput = await runPlanningModelCall(
      transport,
      nativeRequest(
        input,
        criticOperation,
        input.criticProfile,
        JSON.stringify({
          kind: 'critique',
          artifactDigest: compiled.definitionDigest,
          definition: compiled.definition,
        }),
      ),
    );
    const review = CriticResultSchema.parse(JSON.parse(criticOutput));
    if (review.artifactDigest !== compiled.definitionDigest) {
      throw new PlanningError(
        'critic_artifact_mismatch',
        'critic reviewed a different plan artifact',
      );
    }

    const verdict = review.verdict;
    switch (verdict) {
      case 'accept': {
        const binding = planBinding(input);
        const accepted = { compiled, review, binding };
        return {
          ...accepted,
          repairRounds,
          approvalDigest: computePlanApprovalDigest(accepted),
        };
      }
      case 'blocked':
        throw new PlanningError('blocked', review.findings.join('; '));
      case 'revise':
        if (repairRounds >= WORKFLOW_LIMITS.maxRepairRounds) {
          throw new PlanningError(
            'repair_exhausted',
            'planner repair round limit reached',
          );
        }
        findings = review.findings;
        repairRounds += 1;
        break;
      default:
        return assertNever(verdict);
    }
  }
}
