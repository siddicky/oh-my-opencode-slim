import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  approvalChecksDigest,
  approvalScopesDigest,
  approvePlan,
  type LaunchAuthority,
  type StoredPlanApproval,
  validatePlanLaunch,
} from './approval';
import type { PortProbe, UsageReport } from './contracts';
import { compileWorkflow } from './graph';
import { createBunJournal } from './journal';
import {
  type RalplanInput,
  runRalplan,
  type WorkflowOutputReader,
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

// allow: SIZE_OK — one suite owns critique, repair, approval, and launch
// rejection fixtures.
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

class FakeNativeSessionPort implements NativeSessionPort {
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

class QueueOutputReader implements WorkflowOutputReader {
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

function definition(criterion: string) {
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

function createInput(
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

function authorityFor(
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

describe('ralplan planning and approval', () => {
  test('ralplan critique then approval', async () => {
    // Given
    const first = compileWorkflow(definition('Initial criterion'), {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    });
    const revised = compileWorkflow(definition('Revised criterion'), {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    });
    const port = new FakeNativeSessionPort();
    const input = createInput(
      port,
      new QueueOutputReader([
        JSON.stringify(first.definition),
        JSON.stringify({
          verdict: 'revise',
          findings: ['Criterion must be measurable'],
          artifactDigest: first.definitionDigest,
        }),
        JSON.stringify(revised.definition),
        JSON.stringify({
          verdict: 'accept',
          findings: [],
          artifactDigest: revised.definitionDigest,
        }),
      ]),
    );
    const directory = await mkdtemp(join(tmpdir(), 'planning-'));
    temporaryDirectories.push(directory);
    const journal = createBunJournal(join(directory, 'journal.sqlite'));
    const lease = journal.acquireLease(
      input.workspace.projectID,
      'owner-task-10',
    );
    if (lease === null) {
      throw new Error('fixture failed to acquire journal lease');
    }

    // When
    const plan = await runRalplan(input);
    const requestCountBeforeApproval = port.requests.length;
    const approval = approvePlan(
      plan,
      {
        approvedDigest: plan.approvalDigest,
        approvedBy: 'local-user',
        source: 'user-command',
      },
      { journal, lease },
    );

    // Then
    expect(plan.repairRounds).toBe(1);
    expect(port.requests.map((request) => request.profile.agent)).toEqual([
      'workflow-planner',
      'workflow-critic',
      'workflow-planner',
      'workflow-critic',
    ]);
    expect(JSON.parse(plan.compiled.canonicalJson)).toEqual(
      plan.compiled.definition,
    );
    expect(plan.compiled.markdown).toContain('Revised criterion');
    expect(plan.compiled.policySource).toContain(
      plan.compiled.definition.planId,
    );
    expect(plan.compiled.artifactPaths.directory).toBe(
      '.slim/workflows/plans/plan-task-10',
    );
    expect(port.requests).toHaveLength(requestCountBeforeApproval);
    expect(
      journal
        .recover(input.workspace.projectID)
        .states.find((record) => record.kind === 'approval')?.payload,
    ).toEqual(approval);
    validatePlanLaunch(plan, approval, authorityFor(plan));
    journal.close();
  });

  test('ralplan changed hash and forged approval', async () => {
    // Given
    const compiled = compileWorkflow(definition('Approved criterion'), {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    });
    const port = new FakeNativeSessionPort();
    const input = createInput(
      port,
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        JSON.stringify({
          verdict: 'accept',
          findings: [],
          artifactDigest: compiled.definitionDigest,
        }),
      ]),
    );
    const plan = await runRalplan(input);
    const directory = await mkdtemp(join(tmpdir(), 'planning-'));
    temporaryDirectories.push(directory);
    const journal = createBunJournal(join(directory, 'journal.sqlite'));
    const lease = journal.acquireLease(
      input.workspace.projectID,
      'owner-task-10',
    );
    if (lease === null) {
      throw new Error('fixture failed to acquire journal lease');
    }

    // When
    const modelApproval = () =>
      approvePlan(
        plan,
        {
          approvedDigest: plan.approvalDigest,
          approvedBy: 'planner-model',
          source: 'model-output',
        },
        { journal, lease },
      );
    const validApproval = approvePlan(
      plan,
      {
        approvedDigest: plan.approvalDigest,
        approvedBy: 'local-user',
        source: 'user-command',
      },
      { journal, lease },
    );
    const forgedApproval: StoredPlanApproval = {
      ...validApproval,
      approvedDigest: `sha256:${'f'.repeat(64)}`,
    };
    const staleAuthority = {
      ...authorityFor(plan),
      specSha256: 'changed-spec-hash',
    };

    // Then
    expect(modelApproval).toThrow();
    expect(
      journal
        .recover(input.workspace.projectID)
        .states.filter((record) => record.kind === 'approval'),
    ).toHaveLength(1);
    expect(() =>
      validatePlanLaunch(plan, forgedApproval, authorityFor(plan)),
    ).toThrow();
    expect(() =>
      validatePlanLaunch(plan, validApproval, staleAuthority),
    ).toThrow();
    expect(() =>
      validatePlanLaunch(plan, validApproval, {
        ...authorityFor(plan),
        workspaceClean: false,
      }),
    ).toThrow();
    journal.close();
  });

  test('invalid critic JSON is a failed review', async () => {
    // Given
    const compiled = compileWorkflow(definition('Criterion'), {
      maxAdditionalNodes: 0,
      allowedWritePaths: ['src/workflows/**'],
    });
    const input = createInput(
      new FakeNativeSessionPort(),
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        '{"verdict":"accept","findings":[]}',
      ]),
    );

    // When
    const planning = runRalplan(input);

    // Then
    await expect(planning).rejects.toThrow();
  });

  test('ralplan bounds repair rounds and transport retries', async () => {
    // Given
    const compiled = compileWorkflow(definition('Criterion'), {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    });
    const outputs: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      outputs.push(JSON.stringify(compiled.definition));
      outputs.push(
        JSON.stringify({
          verdict: 'revise',
          findings: ['Still incomplete'],
          artifactDigest: compiled.definitionDigest,
        }),
      );
    }
    const port = new FakeNativeSessionPort({ 'plan-task-10:planner:0': 2 });
    const input = createInput(port, new QueueOutputReader(outputs));

    // When
    const planning = runRalplan(input);

    // Then
    await expect(planning).rejects.toThrow();
    expect(port.dispatchAttempts.get('plan-task-10:planner:0')).toBe(3);
  });

  test('launch rejects reviewer override and expansion outside approval', async () => {
    // Given
    const compiled = compileWorkflow(definition('Criterion'), {
      maxAdditionalNodes: 1,
      allowedWritePaths: ['src/workflows/**'],
    });
    const input = createInput(
      new FakeNativeSessionPort(),
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        JSON.stringify({
          verdict: 'accept',
          findings: [],
          artifactDigest: compiled.definitionDigest,
        }),
      ]),
    );
    const plan = await runRalplan(input);
    const directory = await mkdtemp(join(tmpdir(), 'planning-'));
    temporaryDirectories.push(directory);
    const journal = createBunJournal(join(directory, 'journal.sqlite'));
    const lease = journal.acquireLease(
      input.workspace.projectID,
      'owner-task-10',
    );
    if (lease === null) {
      throw new Error('fixture failed to acquire journal lease');
    }
    const approval = approvePlan(
      plan,
      {
        approvedDigest: plan.approvalDigest,
        approvedBy: 'local-user',
        source: 'user-command',
      },
      { journal, lease },
    );

    // When
    const reviewerOverride = {
      ...authorityFor(plan),
      multiCriticOverride: 'different-reviewer',
    };
    const expanded = {
      ...authorityFor(plan),
      requestedAdditionalNodes: 2,
      requestedWritePaths: ['src/workflows/**', 'src/index.ts'],
    };

    // Then
    expect(() =>
      validatePlanLaunch(plan, approval, reviewerOverride),
    ).toThrow();
    expect(() => validatePlanLaunch(plan, approval, expanded)).toThrow();
    journal.close();
  });
});
