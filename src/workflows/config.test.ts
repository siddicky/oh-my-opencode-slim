import { describe, expect, it } from 'bun:test';
import { PluginConfigSchema } from '../config/schema';
import {
  parseCriticReview,
  parseWorkflowDefinition,
  WorkflowsConfigSchema,
} from './config';

describe('workflow configuration', () => {
  it('valid workflow configuration applies deterministic defaults', () => {
    const result = PluginConfigSchema.safeParse({
      workflows: {
        enabled: true,
        roles: {
          planner: 'planner-profile',
          executor: 'executor-profile',
          critic: 'critic-profile',
          debugger: 'debugger-profile',
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.workflows) {
      expect(result.data.workflows.enabled).toBe(true);
      expect(result.data.workflows.roles).toEqual({
        planner: 'planner-profile',
        executor: 'executor-profile',
        critic: 'critic-profile',
        debugger: 'debugger-profile',
      });
    }

    const defaults = WorkflowsConfigSchema.parse(undefined);
    expect(defaults).toEqual({
      enabled: false,
      roles: {
        planner: 'oracle',
        executor: 'fixer',
        critic: 'oracle',
        debugger: 'fixer',
      },
    });
  });

  it('invalid workflow configuration rejects unknown roles, zero budgets, cyclic DAGs, overlapping unordered paths, and malformed critic JSON', () => {
    expect(
      PluginConfigSchema.safeParse({
        workflows: {
          roles: {
            unknown: 'oracle',
          },
        },
      }).success,
    ).toBe(false);

    const validNode = {
      id: 'implement',
      dependsOn: [],
      executorRole: 'executor',
      criticRole: 'critic',
      allowedWritePaths: ['src/workflows/**'],
      inputArtifacts: [],
      checks: [],
      acceptanceCriteria: ['tests pass'],
    };
    const definition = {
      version: 1,
      planId: 'workflow-plan',
      budget: { tokenBudget: 10, timeBudgetMs: 10 },
      nodes: [validNode],
    };

    expect(() =>
      parseWorkflowDefinition({
        ...definition,
        budget: { tokenBudget: 0, timeBudgetMs: 10 },
      }),
    ).toThrow('expected number to be >0');
    expect(() =>
      parseWorkflowDefinition({
        ...definition,
        nodes: [
          { ...validNode, id: 'first', dependsOn: ['second'] },
          { ...validNode, id: 'second', dependsOn: ['first'] },
        ],
      }),
    ).toThrow('Cyclic workflow dependency');
    expect(() =>
      parseWorkflowDefinition({
        ...definition,
        nodes: [
          validNode,
          {
            ...validNode,
            id: 'review',
            allowedWritePaths: ['src/**'],
          },
        ],
      }),
    ).toThrow('overlapping write paths');
    expect(() =>
      parseWorkflowDefinition({
        ...definition,
        nodes: [
          { ...validNode, allowedWritePaths: ['src/*.ts'] },
          {
            ...validNode,
            id: 'glob-review',
            allowedWritePaths: ['src/workflows.ts'],
          },
        ],
      }),
    ).toThrow('overlapping write paths');
    expect(() => parseCriticReview('{not-json')).toThrow(
      'Critic output must be valid JSON.',
    );
  });
});
