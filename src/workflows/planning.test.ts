/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';

import {
  approvePlan,
  type StoredPlanApproval,
  validatePlanLaunch,
} from './approval';
import { compileWorkflow } from './graph';
import { runRalplan } from './planning';
import { persistTestApproval } from './planning-journal-test-support';
import {
  acceptedPlan,
  blockedCriticPlanning,
  exhaustedRepairPlanning,
  invalidCriticPlanning,
} from './planning-scenarios-test-support';
import {
  authorityFor,
  createInput,
  definition,
  FakeNativeSessionPort,
  QueueOutputReader,
} from './planning-test-support';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('ralplan planning and approval', () => {
  test('ralplan critique then approval', async () => {
    // Given
    const envelope = {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/workflows/**'],
    };
    const first = compileWorkflow(definition('Initial criterion'), envelope);
    const revised = compileWorkflow(definition('Revised criterion'), envelope);
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

    // When
    const plan = await runRalplan(input);
    const requestCountBeforeApproval = port.requests.length;
    const persisted = await persistTestApproval(
      plan,
      input.workspace.projectID,
    );
    temporaryDirectories.push(persisted.directory);

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
      persisted.journal
        .recover(input.workspace.projectID)
        .states.find((record) => record.kind === 'approval')?.payload,
    ).toEqual(persisted.approval);
    validatePlanLaunch(plan, persisted.approval, authorityFor(plan));
    persisted.journal.close();
  });

  test('ralplan changed hash and forged approval', async () => {
    // Given
    const { input, plan } = await acceptedPlan();
    const persisted = await persistTestApproval(
      plan,
      input.workspace.projectID,
    );
    temporaryDirectories.push(persisted.directory);
    const forgedApproval: StoredPlanApproval = {
      ...persisted.approval,
      approvedDigest: `sha256:${'f'.repeat(64)}`,
    };

    // When
    const modelApproval = () =>
      approvePlan(
        plan,
        {
          approvedDigest: plan.approvalDigest,
          approvedBy: 'planner-model',
          source: 'model-output',
        },
        persisted.persistence,
      );

    // Then
    expect(modelApproval).toThrow();
    expect(
      persisted.journal
        .recover(input.workspace.projectID)
        .states.filter((record) => record.kind === 'approval'),
    ).toHaveLength(1);
    expect(() =>
      validatePlanLaunch(plan, forgedApproval, authorityFor(plan)),
    ).toThrow();
    expect(() =>
      validatePlanLaunch(plan, persisted.approval, {
        ...authorityFor(plan),
        specSha256: 'changed-spec-hash',
      }),
    ).toThrow();
    expect(() =>
      validatePlanLaunch(plan, persisted.approval, {
        ...authorityFor(plan),
        workspaceClean: false,
      }),
    ).toThrow();
    persisted.journal.close();
  });

  test('invalid critic JSON is a failed review', async () => {
    // Given
    const planning = invalidCriticPlanning();

    // When
    const reviewed = planning;

    // Then
    expect(
      await reviewed.then(
        () => false,
        () => true,
      ),
    ).toBe(true);
  });

  test('blocked critic result stops planning without repair', async () => {
    // Given
    const scenario = blockedCriticPlanning();

    // When
    const planning = scenario.planning;

    // Then
    expect(
      await planning.then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(scenario.port.requests).toHaveLength(2);
  });

  test('ralplan bounds repair rounds and transport retries', async () => {
    // Given
    const scenario = exhaustedRepairPlanning();

    // When
    const planning = scenario.planning;

    // Then
    expect(
      await planning.then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(scenario.port.dispatchAttempts.get('plan-task-10:planner:0')).toBe(
      3,
    );
  });

  test('launch rejects reviewer override and expansion outside approval', async () => {
    // Given
    const { input, plan } = await acceptedPlan(1);
    const persisted = await persistTestApproval(
      plan,
      input.workspace.projectID,
    );
    temporaryDirectories.push(persisted.directory);

    // When
    const reviewerOverride = {
      ...authorityFor(plan),
      multiCriticOverride: 'different-reviewer',
    };
    const expanded = {
      ...authorityFor(plan),
      requestedAdditionalNodes: 2,
      requestedWritePaths: ['src/workflows/new.ts', 'src/index.ts'],
    };

    // Then
    expect(() =>
      validatePlanLaunch(plan, persisted.approval, reviewerOverride),
    ).toThrow();
    expect(() =>
      validatePlanLaunch(plan, persisted.approval, expanded),
    ).toThrow();
    persisted.journal.close();
  });

  test('launch binds base profiles source and valid DAG', async () => {
    // Given
    const { input, plan } = await acceptedPlan();
    const persisted = await persistTestApproval(
      plan,
      input.workspace.projectID,
    );
    temporaryDirectories.push(persisted.directory);
    const node = plan.compiled.definition.nodes.at(0);
    if (node === undefined) {
      throw new Error('fixture plan has no node');
    }
    const invalidPlan = {
      ...plan,
      compiled: {
        ...plan.compiled,
        definition: {
          ...plan.compiled.definition,
          nodes: [node, node],
        },
      },
    };

    // When
    const changedAuthorities = [
      { ...authorityFor(plan), baseCommit: 'changed-base' },
      { ...authorityFor(plan), planSource: 'changed-source' },
      {
        ...authorityFor(plan),
        plannerProfileDigest: `sha256:${'1'.repeat(64)}`,
      },
    ];

    // Then
    for (const authority of changedAuthorities) {
      expect(() =>
        validatePlanLaunch(plan, persisted.approval, authority),
      ).toThrow();
    }
    expect(() =>
      validatePlanLaunch(invalidPlan, persisted.approval, authorityFor(plan)),
    ).toThrow();
    persisted.journal.close();
  });
});
