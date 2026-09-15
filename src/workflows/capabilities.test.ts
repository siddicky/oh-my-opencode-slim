import { describe, expect, it, test } from 'bun:test';
import {
  type CapabilityFailureCode,
  CapabilityPreflightError,
  type CapabilityPreflightFailure,
  type CapabilityPreflightRequest,
  preflightCapabilities,
  requirePreflightSuccess,
} from './capabilities';
import type { NativeToolPort, PortProbe } from './contracts';
import { resolveWorkflowRoleProfiles, WorkflowProfileError } from './profiles';

const MULTI_PROVIDER_AGENTS = {
  'planner-profile': {
    model: 'provider-a/planner-model',
    options: { textVerbosity: 'low' },
  },
  'executor-profile': {
    model: 'provider-b/executor-model',
    mcps: ['playwright'],
    permission: { bash: 'allow' },
  },
  'critic-profile': {
    model: 'provider-c/critic-model',
    mcps: ['langsmith'],
  },
  'debugger-profile': { model: 'provider-b/debugger-model' },
};

const WORKFLOW_ROLES = {
  planner: 'planner-profile',
  executor: 'executor-profile',
  critic: 'critic-profile',
  debugger: 'debugger-profile',
};

const AVAILABLE_MCPS = ['context7', 'gh_grep', 'langsmith', 'playwright'];

const LANGSMITH_QUERY_RUN = { description: 'query langsmith runs' };
const PLAYWRIGHT_NAVIGATE = { description: 'navigate browser context' };
const NATIVE_BASH = { description: 'native bash tool definition' };

function discoveredTools(
  overrides: Record<string, unknown> = {},
  without: readonly string[] = [],
): Map<string, unknown> {
  const base: Record<string, unknown> = {
    read: { description: 'native read tool' },
    bash: NATIVE_BASH,
    lsp_diagnostics: { description: 'native LSP diagnostics' },
    langsmith_query_run: LANGSMITH_QUERY_RUN,
    playwright_navigate: PLAYWRIGHT_NAVIGATE,
  };
  for (const key of without) {
    delete base[key];
  }
  return new Map(Object.entries({ ...base, ...overrides }));
}

function resolveProfiles(
  agents: Record<string, unknown> = MULTI_PROVIDER_AGENTS,
  servers: readonly string[] = AVAILABLE_MCPS,
) {
  return resolveWorkflowRoleProfiles(
    WORKFLOW_ROLES,
    { agents: () => agents as never },
    servers,
  );
}

function fakePort(probe: PortProbe): NativeToolPort {
  return {
    async probe() {
      return probe;
    },
    async reconcile() {
      return 'missing';
    },
    async usage() {
      return 'unavailable';
    },
    async cancel() {
      return 'unsupported';
    },
  };
}

function baseRequest(
  overrides: Partial<CapabilityPreflightRequest> = {},
): CapabilityPreflightRequest {
  return {
    profiles: resolveProfiles(),
    discoveredTools: discoveredTools(),
    configuredMcpServers: AVAILABLE_MCPS,
    requiredMcpTools: [
      {
        role: 'executor',
        requirement: {
          server: 'playwright',
          toolId: 'playwright_navigate',
          scope: 'playwright:context:attempt-1',
        },
      },
      {
        role: 'critic',
        requirement: {
          server: 'langsmith',
          toolId: 'langsmith_query_run',
          scope: 'langsmith:project:acme/run:42',
          credentialScope: 'langsmith',
        },
      },
    ],
    directToolRoles: ['executor'],
    nativeToolPort: fakePort({
      available: true,
      supportsReconcile: true,
      supportsUsage: true,
      supportsCancel: true,
    }),
    credentialPresence: () => true,
    ...overrides,
  };
}

describe('workflow role profiles', () => {
  it('profiles route planner and critic to distinct configured providers', () => {
    const profiles = resolveProfiles();

    expect(profiles.planner.agent).toBe('planner-profile');
    expect(profiles.critic.agent).toBe('critic-profile');
    expect(profiles.planner.model).toEqual({
      providerID: 'provider-a',
      modelID: 'planner-model',
    });
    expect(profiles.critic.model).toEqual({
      providerID: 'provider-c',
      modelID: 'critic-model',
    });
    expect(profiles.planner.model.providerID).not.toBe(
      profiles.critic.model.providerID,
    );
  });

  it('profile digests are deterministic and drift-sensitive', () => {
    const baseline = resolveProfiles();
    const repeat = resolveProfiles();
    expect(repeat.planner.digest).toBe(baseline.planner.digest);

    const reordered = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        options: { textVerbosity: 'low', temperature: 0 },
      },
    });
    const canonical = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        options: { temperature: 0, textVerbosity: 'low' },
      },
    });
    expect(reordered.planner.digest).toBe(canonical.planner.digest);

    const enriched = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        variant: 'high',
        options: { temperature: 0 },
        mcps: ['context7'],
        permission: { read: 'allow' },
      },
    });
    const expected = enriched.planner.digest;
    expect(expected).toMatch(/^sha256:[a-f0-9]{64}$/);

    const driftModel = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model-2',
        variant: 'high',
        options: { temperature: 0 },
        mcps: ['context7'],
        permission: { read: 'allow' },
      },
    });
    expect(driftModel.planner.digest).not.toBe(expected);

    const driftVariant = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        variant: 'low',
        options: { temperature: 0 },
        mcps: ['context7'],
        permission: { read: 'allow' },
      },
    });
    expect(driftVariant.planner.digest).not.toBe(expected);

    const driftOptions = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        variant: 'high',
        options: { temperature: 1 },
        mcps: ['context7'],
        permission: { read: 'allow' },
      },
    });
    expect(driftOptions.planner.digest).not.toBe(expected);

    const driftPermissions = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'planner-profile': {
        model: 'provider-a/planner-model',
        variant: 'high',
        options: { temperature: 0 },
        mcps: ['context7'],
        permission: { read: 'deny' },
      },
    });
    expect(driftPermissions.planner.digest).not.toBe(expected);

    const driftTools = resolveProfiles(
      {
        ...MULTI_PROVIDER_AGENTS,
        'planner-profile': {
          model: 'provider-a/planner-model',
          variant: 'high',
          options: { temperature: 0 },
          mcps: ['context7'],
          permission: { read: 'allow' },
        },
      },
      ['gh_grep'],
    );
    expect(driftTools.planner.digest).not.toBe(expected);
  });

  it('resolved role profiles are frozen typed copies', () => {
    const profiles = resolveProfiles();

    expect(() => {
      (profiles.planner as { agent: string }).agent = 'other';
    }).toThrow();
    expect(() => {
      (profiles.critic.model as { providerID: string }).providerID = 'evil';
    }).toThrow();
    expect(() => {
      (profiles.executor.mcps as string[]).push('context7');
    }).toThrow();
    expect(() => {
      (profiles.planner.options as Record<string, unknown>).injected = true;
    }).toThrow();
    expect(() => {
      (profiles.executor.toolPolicy.deniedTools as string[]).pop();
    }).toThrow();
  });

  it('workflow roles require explicitly configured models', () => {
    expect(() =>
      resolveWorkflowRoleProfiles(
        WORKFLOW_ROLES,
        { agents: () => ({}) as never },
        AVAILABLE_MCPS,
      ),
    ).toThrow(WorkflowProfileError);

    try {
      resolveWorkflowRoleProfiles(
        WORKFLOW_ROLES,
        {
          agents: () => ({ 'planner-profile': {} }) as never,
        },
        AVAILABLE_MCPS,
      );
      throw new Error('expected missing model to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileError);
      expect((error as WorkflowProfileError).code).toBe('missing_model');
    }

    try {
      resolveWorkflowRoleProfiles(
        WORKFLOW_ROLES,
        {
          agents: () =>
            ({ 'planner-profile': { model: 'bare-model-id' } }) as never,
        },
        AVAILABLE_MCPS,
      );
      throw new Error('expected invalid model to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileError);
      expect((error as WorkflowProfileError).code).toBe('invalid_model');
    }

    try {
      resolveWorkflowRoleProfiles(
        { ...WORKFLOW_ROLES, planner: 'ghost-agent' },
        { agents: () => MULTI_PROVIDER_AGENTS as never },
        AVAILABLE_MCPS,
      );
      throw new Error('expected unknown agent to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileError);
      expect((error as WorkflowProfileError).code).toBe('unknown_agent');
    }
  });
});

describe('capability preflight', () => {
  it('capabilities native tools and scoped MCP gate native sessions', async () => {
    const profiles = resolveProfiles();
    const report = await preflightCapabilities(baseRequest());

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);

    // Executors preserve native LSP/coding tools; critics are read-only.
    expect(profiles.executor.toolPolicy.preserveNativeTools).toBe(true);
    expect(profiles.executor.permissions.bash).toBe('allow');
    expect(profiles.critic.toolPolicy.preserveNativeTools).toBe(false);
    for (const writeTool of ['bash', 'edit', 'write', 'patch', 'multiedit']) {
      expect(profiles.critic.permissions[writeTool]).toBe('deny');
    }

    // Scoped names pass through; credentials never do.
    expect(report.scopes).toContain('langsmith:project:acme/run:42');
    expect(report.scopes).toContain('playwright:context:attempt-1');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-');

    // Combined and per-role digests are bound for approval (task 10).
    expect(report.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.digests.critic).toBe(profiles.critic.digest);

    await requirePreflightSuccess(report);
  });

  it('existing tool definitions are reused by reference not cloned', async () => {
    const report = await preflightCapabilities(baseRequest());

    expect(report.resolvedTools.langsmith_query_run).toBe(LANGSMITH_QUERY_RUN);
    expect(report.resolvedTools.playwright_navigate).toBe(PLAYWRIGHT_NAVIGATE);
    expect(report.resolvedTools.bash).toBeUndefined();
    expect(Object.isFrozen(report.resolvedTools)).toBe(true);
  });

  it('readiness uses discovered tool ids rather than prompt claims', async () => {
    const profiles = resolveProfiles({
      ...MULTI_PROVIDER_AGENTS,
      'executor-profile': {
        model: 'provider-b/executor-model',
        mcps: ['playwright'],
        prompt:
          'Always call playwright_navigate and playwright_snapshot first.',
      },
    });

    const report = await preflightCapabilities(
      baseRequest({
        profiles,
        discoveredTools: discoveredTools({}, ['playwright_navigate']),
        requiredMcpTools: [
          {
            role: 'executor',
            requirement: {
              server: 'playwright',
              toolId: 'playwright_navigate',
              scope: 'playwright:context:attempt-1',
            },
          },
        ],
        directToolRoles: [],
      }),
    );

    expect(report.ok).toBe(false);
    expect(
      report.failures.some(
        (failure) =>
          failure.code === 'missing_tool' &&
          failure.target === 'playwright_navigate',
      ),
    ).toBe(true);
  });

  test.each([
    {
      name: 'missing MCP server',
      expected: 'missing_mcp',
      overrides: {
        requiredMcpTools: [
          {
            role: 'critic' as const,
            requirement: {
              server: 'not-configured',
              toolId: 'not-configured_query',
              scope: 'not-configured:project:x',
            },
          },
        ],
        directToolRoles: [],
      },
    },
    {
      name: 'denied tool for role',
      expected: 'denied_tool',
      overrides: {
        profiles: resolveProfiles({
          ...MULTI_PROVIDER_AGENTS,
          'critic-profile': { model: 'provider-c/critic-model' },
        }),
        requiredMcpTools: [
          {
            role: 'critic' as const,
            requirement: {
              server: 'langsmith',
              toolId: 'langsmith_query_run',
              scope: 'langsmith:project:acme/run:42',
            },
          },
        ],
        directToolRoles: [],
      },
    },
    {
      name: 'tool absent from discovered ids',
      expected: 'missing_tool',
      overrides: {
        discoveredTools: discoveredTools({
          playwright_navigate: PLAYWRIGHT_NAVIGATE,
        }),
        requiredMcpTools: [
          {
            role: 'critic' as const,
            requirement: {
              server: 'langsmith',
              toolId: 'langsmith_absent_tool',
              scope: 'langsmith:project:acme/run:42',
            },
          },
        ],
        directToolRoles: [],
      },
    },
    {
      name: 'credentials absent from host',
      expected: 'missing_credentials',
      overrides: {
        credentialPresence: () => false,
        directToolRoles: [],
      },
    },
    {
      name: 'credential presence probe missing',
      expected: 'missing_credentials',
      overrides: {
        credentialPresence: undefined,
        directToolRoles: [],
      },
    },
    {
      name: 'approved profile digest drift',
      expected: 'profile_drift',
      overrides: {
        expectedDigests: {
          critic: `sha256:${'0'.repeat(64)}`,
        },
        directToolRoles: [],
      },
    },
    {
      name: 'direct tool port probe unsupported',
      expected: 'direct_tool_port_unsupported',
      overrides: {
        nativeToolPort: fakePort({
          available: false,
          supportsReconcile: false,
          supportsUsage: false,
          supportsCancel: false,
        }),
      },
    },
    {
      name: 'direct tool port absent',
      expected: 'direct_tool_port_unsupported',
      overrides: {
        nativeToolPort: undefined,
      },
    },
  ])(
    'capabilities missing or denied tool fails preflight: $name',
    async ({
      expected,
      overrides,
    }: {
      expected: CapabilityFailureCode;
      overrides: Partial<CapabilityPreflightRequest>;
    }) => {
      const report = await preflightCapabilities(baseRequest(overrides));

      expect(report.ok).toBe(false);
      const failure: CapabilityPreflightFailure | undefined =
        report.failures.find((candidate) => candidate.code === expected);
      expect(failure).toBeDefined();
      expect(failure?.message.length ?? 0).toBeGreaterThan(0);
      expect(failure?.role).toBeDefined();

      expect(() => requirePreflightSuccess(report)).toThrow(
        CapabilityPreflightError,
      );
    },
  );
});
