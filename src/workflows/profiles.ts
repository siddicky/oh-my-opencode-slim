import { createHash } from 'node:crypto';
import { DEFAULT_AGENT_MCPS, parseList } from '../config/agent-mcps';
import type { AgentName } from '../config/constants';
import type { AgentOverrideConfig } from '../config/schema';
import { WORKFLOW_ROLE_NAMES, type WorkflowRole } from './contracts';
import type { NativeModelProfile } from './runtime/port';

/**
 * Frozen role definitions resolved from CONFIGURED existing profiles.
 * Workflow roles never clone agent factories or tool definitions; they
 * reference the already-registered custom/built-in agents by name and hash
 * the effective model, options, permissions and MCP surface for approval
 * binding (consumed by planning/approval tasks).
 */

export type WorkflowProfileErrorCode =
  | 'unknown_agent'
  | 'missing_model'
  | 'invalid_model';

export class WorkflowProfileError extends Error {
  override readonly name = 'WorkflowProfileError';

  constructor(
    readonly code: WorkflowProfileErrorCode,
    readonly role: WorkflowRole,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowRoleToolPolicy {
  /** True when the role keeps the host's native LSP/coding tool surface. */
  readonly preserveNativeTools: boolean;
  /** Tools forced to deny for this role (write-capable tools for critics). */
  readonly deniedTools: readonly string[];
}

/**
 * Critics get read-only access plus vetted structured checks; arbitrary
 * write-capable shell access is always denied for them.
 */
export const CRITIC_DENIED_TOOLS: readonly string[] = [
  'bash',
  'edit',
  'write',
  'patch',
  'multiedit',
];

export const WORKFLOW_ROLE_TOOL_POLICY: Readonly<
  Record<WorkflowRole, WorkflowRoleToolPolicy>
> = {
  planner: { preserveNativeTools: true, deniedTools: [] },
  executor: { preserveNativeTools: true, deniedTools: [] },
  critic: { preserveNativeTools: false, deniedTools: CRITIC_DENIED_TOOLS },
  debugger: { preserveNativeTools: true, deniedTools: [] },
};

export interface WorkflowRoleProfile {
  readonly role: WorkflowRole;
  /** Configured agent name dispatched by the native runtime (by reference). */
  readonly agent: string;
  /** Effective explicit model: provider/model plus optional variant. */
  readonly model: NativeModelProfile;
  readonly options: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, unknown>>;
  /** MCP servers surviving existing wildcard/exclusion resolution. */
  readonly mcps: readonly string[];
  readonly toolPolicy: WorkflowRoleToolPolicy;
  /** sha256 over the deterministic fingerprint of everything above. */
  readonly digest: string;
}

export type WorkflowRoleProfiles = Readonly<
  Record<WorkflowRole, WorkflowRoleProfile>
>;

/** Minimal surface of RuntimeConfig consumed for resolution. */
export interface WorkflowAgentConfigSource {
  readonly agents: () => Record<string, AgentOverrideConfig>;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function resolveRoleModel(
  role: WorkflowRole,
  agent: string,
  override: AgentOverrideConfig,
): NativeModelProfile {
  const declared = override.model;
  if (declared === undefined) {
    throw new WorkflowProfileError(
      'missing_model',
      role,
      `Workflow role '${role}' requires an explicit model on agent '${agent}'; configure agents.${agent}.model.`,
    );
  }

  let modelId: string;
  let variant = override.variant;
  if (typeof declared === 'string') {
    modelId = declared;
  } else {
    const primary = declared[0];
    if (primary === undefined) {
      throw new WorkflowProfileError(
        'missing_model',
        role,
        `Workflow role '${role}' agent '${agent}' declares an empty model chain; workflow profiles require one explicit model.`,
      );
    }
    if (typeof primary === 'string') {
      modelId = primary;
    } else {
      modelId = primary.id;
      variant = primary.variant ?? variant;
    }
  }

  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new WorkflowProfileError(
      'invalid_model',
      role,
      `Workflow role '${role}' model '${modelId}' must be 'provider/model'; got no provider segment.`,
    );
  }
  const model: NativeModelProfile = {
    providerID: modelId.slice(0, separator),
    modelID: modelId.slice(separator + 1),
  };
  if (variant !== undefined) {
    return { ...model, variant };
  }
  return model;
}

function profileFingerprint(
  profile: Omit<WorkflowRoleProfile, 'digest'>,
): Record<string, unknown> {
  return {
    role: profile.role,
    agent: profile.agent,
    model: profile.model,
    options: profile.options,
    permissions: profile.permissions,
    mcps: [...profile.mcps].sort(),
    toolPolicy: {
      preserveNativeTools: profile.toolPolicy.preserveNativeTools,
      deniedTools: [...profile.toolPolicy.deniedTools].sort(),
    },
  };
}

export function resolveWorkflowRoleProfile(
  role: WorkflowRole,
  targetAgent: string,
  source: WorkflowAgentConfigSource,
  availableMcpServers: readonly string[],
): WorkflowRoleProfile {
  const override = source.agents()[targetAgent];
  if (!override) {
    throw new WorkflowProfileError(
      'unknown_agent',
      role,
      `Workflow role '${role}' targets agent '${targetAgent}', which is neither a built-in agent nor declared in agents configuration.`,
    );
  }

  const policy = WORKFLOW_ROLE_TOOL_POLICY[role];
  const permissionConfig = override.permission;
  const permissions: Record<string, unknown> = {
    ...(permissionConfig !== null && typeof permissionConfig === 'object'
      ? permissionConfig
      : {}),
  };
  // Role policy wins over user grants: critics can never regain
  // write-capable shell access through agent permission overrides.
  for (const tool of policy.deniedTools) {
    permissions[tool] = 'deny';
  }

  const configuredMcps =
    override.mcps ?? DEFAULT_AGENT_MCPS[targetAgent as AgentName] ?? [];
  const mcps = parseList(configuredMcps, [...availableMcpServers]).sort();

  const partial: Omit<WorkflowRoleProfile, 'digest'> = {
    role,
    agent: targetAgent,
    model: deepFreeze(resolveRoleModel(role, targetAgent, override)),
    options: deepFreeze({ ...(override.options ?? {}) }),
    permissions: deepFreeze(permissions),
    mcps: deepFreeze(mcps),
    toolPolicy: deepFreeze({
      preserveNativeTools: policy.preserveNativeTools,
      deniedTools: [...policy.deniedTools],
    }),
  };
  const profile: WorkflowRoleProfile = {
    ...partial,
    digest: canonicalDigest(profileFingerprint(partial)),
  };
  return deepFreeze(profile);
}

export function resolveWorkflowRoleProfiles(
  roles: Readonly<Record<WorkflowRole, string>>,
  source: WorkflowAgentConfigSource,
  availableMcpServers: readonly string[],
): WorkflowRoleProfiles {
  const resolved = {} as Record<WorkflowRole, WorkflowRoleProfile>;
  for (const role of WORKFLOW_ROLE_NAMES) {
    resolved[role] = resolveWorkflowRoleProfile(
      role,
      roles[role],
      source,
      availableMcpServers,
    );
  }
  return deepFreeze(resolved);
}
