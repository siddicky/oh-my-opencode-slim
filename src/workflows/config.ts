import { z } from 'zod';
import { WORKFLOW_ROLE_NAMES, type WorkflowRole } from './contracts';
import {
  WorkflowDefinitionSchema,
  WorkflowReviewSchema,
  WorkflowValidationError,
} from './schema';

export const WORKFLOW_ROLES = WORKFLOW_ROLE_NAMES satisfies readonly WorkflowRole[];

export const DEFAULT_WORKFLOW_ROLES = {
  planner: 'oracle',
  executor: 'fixer',
  critic: 'oracle',
  debugger: 'fixer',
};

export const WORKFLOW_LIMITS = {
  maxActiveNodeAttempts: 4,
  maxActiveModelCallsPerProvider: 2,
  maxRepairRounds: 3,
  maxTransportRetries: 2,
};

const WorkflowRoleAgentSchema = z.string().trim().min(1);

export const WorkflowRolesConfigSchema = z
  .object({
    planner: WorkflowRoleAgentSchema.default(DEFAULT_WORKFLOW_ROLES.planner),
    executor: WorkflowRoleAgentSchema.default(DEFAULT_WORKFLOW_ROLES.executor),
    critic: WorkflowRoleAgentSchema.default(DEFAULT_WORKFLOW_ROLES.critic),
    debugger: WorkflowRoleAgentSchema.default(DEFAULT_WORKFLOW_ROLES.debugger),
  })
  .strict();

export const WorkflowsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    roles: WorkflowRolesConfigSchema.default(DEFAULT_WORKFLOW_ROLES),
  })
  .strict()
  .default({
    enabled: false,
    roles: DEFAULT_WORKFLOW_ROLES,
  });

export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>;

function validationError(error: z.ZodError): WorkflowValidationError {
  return new WorkflowValidationError(
    'invalid_workflow_input',
    error.issues.map((issue) => issue.message).join('; '),
  );
}

export function parseWorkflowDefinition(input: unknown): z.infer<
  typeof WorkflowDefinitionSchema
> {
  const result = WorkflowDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw validationError(result.error);
  }
  return result.data;
}

export function parseCriticReview(input: string): z.infer<
  typeof WorkflowReviewSchema
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new WorkflowValidationError(
      'invalid_critic_json',
      'Critic output must be valid JSON.',
    );
  }

  const result = WorkflowReviewSchema.safeParse(parsed);
  if (!result.success) {
    throw validationError(result.error);
  }
  return result.data;
}
