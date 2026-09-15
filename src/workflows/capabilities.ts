import type { NativeToolPort, WorkflowRole } from './contracts';
import { WORKFLOW_ROLE_NAMES } from './contracts';
import { canonicalDigest, type WorkflowRoleProfiles } from './profiles';

/**
 * Capability preflight over EXISTING configured infrastructure. Readiness is
 * decided by actual discovered tool IDs and the NativeToolPort probe result —
 * never by prompt or skill claims. Credentials stay with the host: host
 * callbacks only ever receive scoped names.
 */

export type CapabilityFailureCode =
  | 'missing_mcp'
  | 'denied_tool'
  | 'missing_tool'
  | 'missing_credentials'
  | 'profile_drift'
  | 'direct_tool_port_unsupported';

export interface CapabilityPreflightFailure {
  readonly code: CapabilityFailureCode;
  readonly role: WorkflowRole;
  /** Missing MCP server, denied/missing tool id, credential scope, or role. */
  readonly target: string;
  readonly message: string;
}

export interface ScopedMcpToolRequirement {
  /** Configured MCP server name (e.g. langsmith, playwright). */
  readonly server: string;
  /** Exact discovered tool id required for readiness. */
  readonly toolId: string;
  /**
   * Scoped name handed to host callbacks (e.g. 'langsmith:project:acme/run:42'
   * or 'playwright:context:<attempt>'). Never contains credential values.
   */
  readonly scope: string;
  /** Credential scope the host must answer present for (name only). */
  readonly credentialScope?: string;
}

export interface RoleCapabilityRequirement {
  readonly role: WorkflowRole;
  readonly requirement: ScopedMcpToolRequirement;
}

export interface CapabilityPreflightRequest {
  readonly profiles: WorkflowRoleProfiles;
  /** Approved digests (e.g. persisted with the plan approval); mismatch = drift. */
  readonly expectedDigests?: Readonly<Partial<Record<WorkflowRole, string>>>;
  /** Actual discovered tool ids mapped to their existing definitions. */
  readonly discoveredTools: ReadonlyMap<string, unknown>;
  /** MCP servers configured on the host (merged builtin + custom). */
  readonly configuredMcpServers: readonly string[];
  /** Scoped MCP capability requirements per role. */
  readonly requiredMcpTools?: readonly RoleCapabilityRequirement[];
  /** Roles whose nodes call tools directly through a NativeToolPort. */
  readonly directToolRoles?: readonly WorkflowRole[];
  readonly nativeToolPort?: NativeToolPort;
  /** Host-owned credential presence probe; receives scope names only. */
  readonly credentialPresence?: (scope: string) => boolean;
}

export interface CapabilityPreflightReport {
  readonly ok: boolean;
  readonly failures: readonly CapabilityPreflightFailure[];
  readonly digests: Readonly<Record<WorkflowRole, string>>;
  /** Combined digest over every role profile digest; binds approvals. */
  readonly digest: string;
  /** References (not clones) of the existing definitions that passed. */
  readonly resolvedTools: Readonly<Record<string, unknown>>;
  /** Scoped names passed to the host for this launch. */
  readonly scopes: readonly string[];
}

export class CapabilityPreflightError extends Error {
  override readonly name = 'CapabilityPreflightError';

  constructor(readonly failures: readonly CapabilityPreflightFailure[]) {
    super(
      `Capability preflight failed (${failures.length}): ${failures
        .map((failure) => `${failure.code} [${failure.role}] ${failure.target}`)
        .join('; ')}`,
    );
  }
}

function checkMcpToolRequirement(
  request: CapabilityPreflightRequest,
  configuredServers: ReadonlySet<string>,
  role: WorkflowRole,
  requirement: ScopedMcpToolRequirement,
): CapabilityPreflightFailure | undefined {
  if (!configuredServers.has(requirement.server)) {
    return {
      code: 'missing_mcp',
      role,
      target: requirement.server,
      message: `Required MCP server '${requirement.server}' is not configured on the host. Configure it in the plugin/host MCP settings; the workflow never installs servers globally.`,
    };
  }
  const profile = request.profiles[role];
  if (!profile.mcps.includes(requirement.server)) {
    return {
      code: 'denied_tool',
      role,
      target: requirement.toolId,
      message: `MCP permission resolution denies '${requirement.toolId}' for role '${role}': server '${requirement.server}' is not in the role's resolved MCP allowlist.`,
    };
  }
  if (!request.discoveredTools.has(requirement.toolId)) {
    return {
      code: 'missing_tool',
      role,
      target: requirement.toolId,
      message: `Discovered tool IDs do not include '${requirement.toolId}' for role '${role}'. Readiness follows actually discovered tools, not prompt or skill claims.`,
    };
  }
  if (requirement.credentialScope !== undefined) {
    const present =
      request.credentialPresence?.(requirement.credentialScope) ?? false;
    if (!present) {
      return {
        code: 'missing_credentials',
        role,
        target: requirement.credentialScope,
        message: `Host has no credentials for scope '${requirement.credentialScope}' required by '${requirement.toolId}'. Add credentials to the host configuration; they are never copied into workflow manifests.`,
      };
    }
  }
  return undefined;
}

export async function preflightCapabilities(
  request: CapabilityPreflightRequest,
): Promise<CapabilityPreflightReport> {
  const failures: CapabilityPreflightFailure[] = [];
  const resolvedTools: Record<string, unknown> = {};
  const scopes: string[] = [];

  const expectedDigests = request.expectedDigests ?? {};
  for (const role of WORKFLOW_ROLE_NAMES) {
    const expected = expectedDigests[role];
    if (expected === undefined) {
      continue;
    }
    const actual = request.profiles[role].digest;
    if (actual !== expected) {
      failures.push({
        code: 'profile_drift',
        role,
        target: role,
        message: `Workflow role '${role}' profile digest '${actual}' does not match approved digest '${expected}'. Re-approve the plan before launching.`,
      });
    }
  }

  const configuredServers = new Set(request.configuredMcpServers);
  for (const { role, requirement } of request.requiredMcpTools ?? []) {
    const failure = checkMcpToolRequirement(
      request,
      configuredServers,
      role,
      requirement,
    );
    if (failure) {
      failures.push(failure);
      continue;
    }
    resolvedTools[requirement.toolId] = request.discoveredTools.get(
      requirement.toolId,
    );
    scopes.push(requirement.scope);
  }

  for (const role of request.directToolRoles ?? []) {
    // Consult the existing probe result; never re-detect host capability.
    const probe = request.nativeToolPort
      ? await request.nativeToolPort.probe()
      : undefined;
    if (!probe?.available) {
      failures.push({
        code: 'direct_tool_port_unsupported',
        role,
        target: role,
        message: `Role '${role}' declares direct tool nodes, but the host NativeToolPort probe reports unsupported. Reject direct-tool nodes before launch; native-agent tool use remains available.`,
      });
    }
  }

  const digests = Object.fromEntries(
    WORKFLOW_ROLE_NAMES.map((role) => [role, request.profiles[role].digest]),
  ) as Record<WorkflowRole, string>;

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures),
    digests: Object.freeze(digests),
    digest: canonicalDigest({ digests }),
    resolvedTools: Object.freeze(resolvedTools),
    scopes: Object.freeze(scopes),
  });
}

export function requirePreflightSuccess(
  report: CapabilityPreflightReport,
): CapabilityPreflightReport {
  if (!report.ok) {
    throw new CapabilityPreflightError(report.failures);
  }
  return report;
}
