import { z } from 'zod';

import { canonicalDigest } from './profiles';
import { WorkflowDefinitionSchema } from './schema';

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export type ExpansionEnvelope = {
  readonly maxAdditionalNodes: number;
  readonly allowedWritePaths: readonly string[];
};

const ExpansionEnvelopeSchema = z
  .object({
    maxAdditionalNodes: z.number().int().nonnegative(),
    allowedWritePaths: z.array(
      z
        .string()
        .trim()
        .min(1)
        .refine(
          (path) => !path.startsWith('/') && !path.split('/').includes('..'),
          'write paths must remain inside the project',
        ),
    ),
  })
  .strict();

export type CompiledWorkflow = {
  readonly definition: WorkflowDefinition;
  readonly canonicalJson: string;
  readonly policySource: string;
  readonly markdown: string;
  readonly definitionDigest: string;
  readonly policyDigest: string;
  readonly markdownDigest: string;
  readonly expansionEnvelope: ExpansionEnvelope;
  readonly artifactPaths: {
    readonly directory: string;
    readonly json: string;
    readonly policy: string;
    readonly markdown: string;
  };
};

function orderedDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    nodes: [...definition.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        ...node,
        dependsOn: [...node.dependsOn].sort(),
        allowedWritePaths: [...node.allowedWritePaths].sort(),
        inputArtifacts: [...node.inputArtifacts].sort(),
      })),
  };
}

function renderPolicy(definition: WorkflowDefinition): string {
  return [
    `'use strict';`,
    `const workflow = ${JSON.stringify(definition, null, 2)};`,
    'workflow;',
    '',
  ].join('\n');
}

function renderMarkdown(definition: WorkflowDefinition): string {
  const sections = definition.nodes.map((node) => {
    const dependencies =
      node.dependsOn.length === 0 ? 'none' : node.dependsOn.join(', ');
    const paths = node.allowedWritePaths
      .map((path) => `\`${path}\``)
      .join(', ');
    const checks = node.checks.map(
      (check) =>
        `- \`${[check.command, ...check.args].join(' ')}\` (cwd: \`${check.cwd}\`)`,
    );
    const criteria = node.acceptanceCriteria.map(
      (criterion) => `- ${criterion}`,
    );
    return [
      `## ${node.id}`,
      '',
      `- Depends on: ${dependencies}`,
      `- Executor: ${node.executorRole}`,
      `- Critic: ${node.criticRole}`,
      `- Write paths: ${paths || 'none'}`,
      `- Input artifacts: ${node.inputArtifacts.join(', ') || 'none'}`,
      '',
      '### Checks',
      '',
      ...(checks.length === 0 ? ['- none'] : checks),
      '',
      '### Acceptance criteria',
      '',
      ...criteria,
    ].join('\n');
  });
  return [
    `# Plan ${definition.planId}`,
    '',
    `Version: ${definition.version}`,
    `Token budget: ${definition.budget.tokenBudget}`,
    `Time budget (ms): ${definition.budget.timeBudgetMs}`,
    '',
    ...sections,
    '',
  ].join('\n');
}

export function compileWorkflow(
  definitionInput: unknown,
  expansionEnvelope: ExpansionEnvelope,
): CompiledWorkflow {
  const definition = orderedDefinition(
    WorkflowDefinitionSchema.parse(definitionInput),
  );
  const canonicalJson = JSON.stringify(definition, null, 2);
  const policySource = renderPolicy(definition);
  const markdown = renderMarkdown(definition);
  const parsedEnvelope = ExpansionEnvelopeSchema.parse(expansionEnvelope);
  const directory = `.slim/workflows/plans/${definition.planId}`;
  return {
    definition,
    canonicalJson,
    policySource,
    markdown,
    definitionDigest: canonicalDigest(definition),
    policyDigest: canonicalDigest(policySource),
    markdownDigest: canonicalDigest(markdown),
    expansionEnvelope: {
      maxAdditionalNodes: parsedEnvelope.maxAdditionalNodes,
      allowedWritePaths: [...parsedEnvelope.allowedWritePaths].sort(),
    },
    artifactPaths: {
      directory,
      json: `${directory}/plan.json`,
      policy: `${directory}/policy.js`,
      markdown: `${directory}/plan.md`,
    },
  };
}
