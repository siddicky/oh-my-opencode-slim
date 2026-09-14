import { createHash } from 'node:crypto';

import {
  approvalChecksDigest,
  approvalScopesDigest,
  type LaunchAuthority,
} from './approval';
import type { PortProbe, UsageReport } from './contracts';
import type {
  RalplanInput,
  runRalplan,
  WorkflowOutputReader,
} from './planning';
import {
  resolveWorkflowRoleProfile,
  type WorkflowRoleProfile,
} from './profiles';
import type {
  NativeDispatchResult,
  NativeSessionPort,
  NativeSessionRequest,
} from './runtime/port';

export class FakeNativeSessionPort implements NativeSessionPort {
  readonly requests: NativeSessionRequest[] = [];
  readonly dispatchAttempts = new Map<string, number>();

  constructor(
    private readonly uncertainAttempts: Readonly<Record<string, number>> = {},
  ) {}

  async probe(): Promise<PortProbe> {
    return {
      available: true,
      supportsReconcile: true,
      supportsUsage: true,
      supportsCancel: true,
    };
  }

  async assertUnattendedReady(): Promise<void> {}

  async dispatch(request: NativeSessionRequest): Promise<NativeDispatchResult> {
    this.requests.push(request);
    const attempts = (this.dispatchAttempts.get(request.operationId) ?? 0) + 1;
    this.dispatchAttempts.set(request.operationId, attempts);
    if (attempts <= (this.uncertainAttempts[request.operationId] ?? 0)) {
      return { state: 'uncertain', stage: 'create' };
    }
    return {
      state: 'prompted',
      sessionID: `session:${request.operationId}`,
    };
  }

  async wait(): Promise<'terminal'> {
    return 'terminal';
  }

  async reconcile(): Promise<'missing'> {
    return 'missing';
  }

  async usage(): Promise<UsageReport> {
    return {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 0,
      cachedTokens: 0,
    };
  }

  async cancel(): Promise<'cancelled'> {
    return 'cancelled';
  }
}

export class QueueOutputReader implements WorkflowOutputReader {
  constructor(private readonly outputs: string[]) {}

  async read(): Promise<string> {
    const output = this.outputs.shift();
    if (output === undefined) {
      throw new Error('fixture output queue exhausted');
    }
    return output;
  }
}

function createProfiles(): {
  readonly planner: WorkflowRoleProfile;
  readonly critic: WorkflowRoleProfile;
} {
  const source = {
    agents: () => ({
      'workflow-planner': {
        model: 'planner-provider/planner-model',
        variant: 'high',
        options: { temperature: 0 },
        permission: {},
        mcps: [],
      },
      'workflow-critic': {
        model: 'critic-provider/critic-model',
        variant: 'medium',
        options: { temperature: 0 },
        permission: {},
        mcps: [],
      },
    }),
  };
  return {
    planner: resolveWorkflowRoleProfile(
      'planner',
      'workflow-planner',
      source,
      [],
    ),
    critic: resolveWorkflowRoleProfile('critic', 'workflow-critic', source, []),
  };
}

export function definition(criterion: string) {
  return {
    version: 1,
    planId: 'plan-task-10',
    budget: { tokenBudget: 10_000, timeBudgetMs: 60_000 },
    nodes: [
      {
        id: 'implementation',
        dependsOn: [],
        executorRole: 'executor',
        criticRole: 'critic',
        allowedWritePaths: ['src/workflows/**'],
        inputArtifacts: ['spec.md'],
        checks: [
          {
            command: 'bun',
            args: ['test', 'src/workflows/planning.test.ts'],
            cwd: '.',
            timeoutMs: 30_000,
          },
        ],
        acceptanceCriteria: [criterion],
      },
    ],
  };
}

export function createInput(
  port: NativeSessionPort,
  outputReader: WorkflowOutputReader,
): RalplanInput {
  const profiles = createProfiles();
  const specText = '# Spec\nImplement durable planning.';
  return {
    planId: 'plan-task-10',
    parentSessionID: 'parent-session',
    specText,
    specSha256: createHash('sha256').update(specText).digest('hex'),
    specManifest: {
      version: 1,
      interviewId: 'interview-task-10',
      sessionID: 'interview-session',
      specPath: '/repo/spec.md',
      specSha256: createHash('sha256').update(specText).digest('hex'),
      specBytes: Buffer.byteLength(specText, 'utf8'),
      interviewerAgent: 'deep-interviewer',
      finalizedAt: '2026-09-14T00:00:00.000Z',
    },
    source: 'deep-interview',
    baseCommit: 'abc123',
    plannerProfile: profiles.planner,
    criticProfile: profiles.critic,
    capabilityDigest: `sha256:${'c'.repeat(64)}`,
    workspace: {
      directory: '/repo',
      canonical: '/repo',
      projectID: 'project-task-10',
    },
    expansionEnvelope: {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    },
    budget: {
      tokenBudget: 1_000,
      timeBudgetMs: 60_000,
      knownInputTokens: 10,
      responseAllowanceTokens: 100,
    },
    port,
    outputReader,
    now: () => 1_000,
  };
}

export function authorityFor(
  plan: Awaited<ReturnType<typeof runRalplan>>,
): LaunchAuthority {
  return {
    specSha256: plan.binding.specSha256,
    planSource: plan.binding.source,
    projectRoot: plan.binding.projectRoot,
    baseCommit: plan.binding.baseCommit,
    plannerProfileDigest: plan.binding.plannerProfileDigest,
    criticProfileDigest: plan.binding.criticProfileDigest,
    capabilityDigest: plan.binding.capabilityDigest,
    reviewerAgent: plan.binding.reviewerAgent,
    policyDigest: plan.compiled.policyDigest,
    checksDigest: approvalChecksDigest(plan),
    scopesDigest: approvalScopesDigest(plan),
    expansionEnvelope: plan.compiled.expansionEnvelope,
    workspaceClean: true,
  };
}
