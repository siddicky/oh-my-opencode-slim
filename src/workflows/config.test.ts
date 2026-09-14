import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PluginConfigSchema } from '../config/schema';
import {
  parseCriticReview,
  parseWorkflowDefinition,
  WorkflowsConfigSchema,
} from './config';

const MULTI_PROVIDER_AGENTS = {
  'planner-profile': { model: 'provider-a/planner-model' },
  'executor-profile': { model: 'provider-b/executor-model' },
  'critic-profile': { model: 'provider-c/critic-model' },
  'debugger-profile': { model: 'provider-d/debugger-model' },
};

interface GeneratedSchemaShape {
  properties?: {
    workflows?: {
      properties?: {
        enabled?: { type?: string };
        roles?: { properties?: Record<string, unknown> };
      };
    };
  };
}

describe('workflow configuration', () => {
  it('valid workflow configuration applies deterministic defaults', () => {
    const result = PluginConfigSchema.safeParse({
      agents: MULTI_PROVIDER_AGENTS,
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
      for (const [name, override] of Object.entries(MULTI_PROVIDER_AGENTS)) {
        expect(result.data.agents?.[name]?.model).toBe(override.model);
      }
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
    expect(() =>
      parseWorkflowDefinition({
        ...definition,
        nodes: [
          { ...validNode, allowedWritePaths: ['src/*.ts'] },
          {
            ...validNode,
            id: 'glob-glob-review',
            allowedWritePaths: ['src/workflows.*'],
          },
        ],
      }),
    ).toThrow('overlapping write paths');
    expect(() => parseCriticReview('{not-json')).toThrow(
      'Critic output must be valid JSON.',
    );
  });

  it('workflow role targets must resolve to built-in or declared custom agents', () => {
    const undeclared = PluginConfigSchema.safeParse({
      workflows: {
        enabled: true,
        roles: {
          planner: 'definitely-missing-agent',
        },
      },
    });
    expect(undeclared.success).toBe(false);
    if (!undeclared.success) {
      expect(
        undeclared.error.issues.some(
          (issue) => issue.path.join('.') === 'workflows.roles.planner',
        ),
      ).toBe(true);
    }

    const builtIn = PluginConfigSchema.safeParse({
      workflows: {
        enabled: true,
        roles: {
          planner: 'oracle',
          executor: 'fixer',
          critic: 'oracle',
          debugger: 'fixer',
        },
      },
    });
    expect(builtIn.success).toBe(true);

    const mixed = PluginConfigSchema.safeParse({
      agents: {
        'custom-reviewer': { model: 'provider-a/reviewer-model' },
      },
      workflows: {
        enabled: true,
        roles: {
          planner: 'oracle',
          executor: 'custom-reviewer',
          critic: 'oracle',
          debugger: 'fixer',
        },
      },
    });
    expect(mixed.success).toBe(true);
  });

  it('generated public schema contains the workflows shape and stays generator-consistent', () => {
    const schemaPath = join(
      import.meta.dir,
      '..',
      '..',
      'oh-my-opencode-slim.schema.json',
    );
    const actual = readFileSync(schemaPath, 'utf8');
    const committed = JSON.parse(actual) as GeneratedSchemaShape;

    const workflowsShape = committed.properties?.workflows;
    expect(workflowsShape).toBeDefined();
    expect(workflowsShape?.properties?.enabled?.type).toBe('boolean');
    expect(
      Object.keys(workflowsShape?.properties?.roles?.properties ?? {}),
    ).toEqual(['planner', 'executor', 'critic', 'debugger']);

    const generated = z.toJSONSchema(PluginConfigSchema, { io: 'input' });
    const jsonSchema = {
      ...generated,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'oh-my-opencode-slim',
      description:
        'Configuration schema for oh-my-opencode-slim plugin for OpenCode',
    };
    expect(actual).toBe(`${JSON.stringify(jsonSchema, null, 2)}\n`);
  });
});
