import { z } from 'zod';
import { WORKFLOW_ROLE_NAMES } from './contracts';

const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(?![\\/])(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/,
    'Expected a relative path without parent-directory traversal.',
  );

export const WorkflowPlanIdSchema = z.string().trim().min(1).brand<'WorkflowPlanId'>();
export const WorkflowRunIdSchema = z.string().trim().min(1).brand<'WorkflowRunId'>();
export const WorkflowNodeIdSchema = z.string().trim().min(1).brand<'WorkflowNodeId'>();
export const WorkflowOperationIdSchema = z
  .string()
  .trim()
  .min(1)
  .brand<'WorkflowOperationId'>();

export const WorkflowBudgetSchema = z
  .object({
    tokenBudget: z.number().int().positive(),
    timeBudgetMs: z.number().int().positive(),
  })
  .strict();

export const WorkflowNodeSchema = z
  .object({
    id: WorkflowNodeIdSchema,
    dependsOn: z.array(WorkflowNodeIdSchema).default([]),
    executorRole: z.enum(WORKFLOW_ROLE_NAMES),
    criticRole: z.enum(WORKFLOW_ROLE_NAMES),
    allowedWritePaths: z.array(RelativePathSchema).default([]),
    inputArtifacts: z.array(z.string().trim().min(1)).default([]),
    checks: z
      .array(
        z
          .object({
            command: z.string().trim().min(1),
            args: z.array(z.string()),
            cwd: RelativePathSchema,
            timeoutMs: z.number().int().positive(),
          })
          .strict(),
      )
      .default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

function pathPrefix(path: string): string {
  return path.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/$/, '');
}

function isGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

function globMatches(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) {
      continue;
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += /[\\^$+?.()|{}\[\]]/.test(character)
      ? `\\${character}`
      : character;
  }
  return new RegExp(`${expression}$`).test(path);
}

function pathsOverlap(left: string, right: string): boolean {
  if (isGlob(left) && !isGlob(right)) {
    return globMatches(left, right);
  }
  if (!isGlob(left) && isGlob(right)) {
    return globMatches(right, left);
  }
  const leftPrefix = pathPrefix(left);
  const rightPrefix = pathPrefix(right);
  return (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

function hasDependency(
  nodeId: string,
  dependencyId: string,
  nodesById: ReadonlyMap<string, z.infer<typeof WorkflowNodeSchema>>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(nodeId)) {
    return false;
  }
  visited.add(nodeId);
  const node = nodesById.get(nodeId);
  if (!node) {
    return false;
  }
  return node.dependsOn.some(
    (current) =>
      current === dependencyId ||
      hasDependency(current, dependencyId, nodesById, visited),
  );
}

export const WorkflowDefinitionSchema = z
  .object({
    version: z.literal(1),
    planId: WorkflowPlanIdSchema,
    budget: WorkflowBudgetSchema,
    nodes: z.array(WorkflowNodeSchema).min(1),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const nodesById = new Map<string, z.infer<typeof WorkflowNodeSchema>>();
    for (const [index, node] of definition.nodes.entries()) {
      if (nodesById.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'id'],
          message: `Duplicate workflow node ID: ${node.id}`,
        });
      }
      nodesById.set(node.id, node);
    }

    for (const [index, node] of definition.nodes.entries()) {
      for (const dependency of node.dependsOn) {
        if (!nodesById.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'dependsOn'],
            message: `Unknown workflow dependency: ${dependency}`,
          });
        }
      }
      if (hasDependency(node.id, node.id, nodesById)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'dependsOn'],
          message: `Cyclic workflow dependency involving: ${node.id}`,
        });
      }
    }

    for (let leftIndex = 0; leftIndex < definition.nodes.length; leftIndex += 1) {
      const left = definition.nodes[leftIndex];
      if (!left) {
        continue;
      }
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < definition.nodes.length;
        rightIndex += 1
      ) {
        const right = definition.nodes[rightIndex];
        if (!right) {
          continue;
        }
        const ordered =
          hasDependency(left.id, right.id, nodesById) ||
          hasDependency(right.id, left.id, nodesById);
        if (
          !ordered &&
          left.allowedWritePaths.some((leftPath) =>
            right.allowedWritePaths.some((rightPath) =>
              pathsOverlap(leftPath, rightPath),
            ),
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', rightIndex, 'allowedWritePaths'],
            message: `Unordered workflow nodes ${left.id} and ${right.id} have overlapping write paths.`,
          });
        }
      }
    }
  });

export const WorkflowOperationSchema = z
  .object({
    id: WorkflowOperationIdSchema,
    nodeId: WorkflowNodeIdSchema,
    kind: z.enum(['native-session', 'native-tool']),
    state: z.enum(['intent', 'admitted', 'prompted', 'terminal', 'uncertain']),
  })
  .strict();

export const WorkflowRunSchema = z
  .object({
    id: WorkflowRunIdSchema,
    planId: WorkflowPlanIdSchema,
    budget: WorkflowBudgetSchema,
    state: z.enum(['pending', 'running', 'paused', 'completed', 'failed']),
  })
  .strict();

export const WorkflowReviewSchema = z
  .object({
    nodeId: WorkflowNodeIdSchema,
    criticRole: z.enum(WORKFLOW_ROLE_NAMES),
    verdict: z.enum(['accept', 'reject']),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    summary: z.string().trim().min(1),
  })
  .strict();

export const WorkflowCheckpointSchema = z
  .object({
    runId: WorkflowRunIdSchema,
    operationIds: z.array(WorkflowOperationIdSchema),
    snapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const WorkflowApprovalSchema = z
  .object({
    planId: WorkflowPlanIdSchema,
    approvedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approvedBy: z.string().trim().min(1),
  })
  .strict();

export class WorkflowValidationError extends Error {
  constructor(
    readonly code: 'invalid_workflow_input' | 'invalid_critic_json',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}
