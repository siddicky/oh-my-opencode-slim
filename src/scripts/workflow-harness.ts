#!/usr/bin/env bun

/**
 * Live harness for the workflow engine (ralplan + approval + journal).
 *
 * Adapts a real `@opencode-ai/sdk` client (v1 `opencode serve` host) into a
 * `V1ClientHost`, wraps it with `createV1SessionPort`, and drives
 * `runRalplan` end to end: the planner compiles a workflow definition from a
 * spec, the critic reviews it, and the result is approved into a real sqlite
 * journal via `approvePlan`.
 *
 * Usage:
 *   bun scripts/workflow-harness.ts \
 *     --base-url http://localhost:4096 \
 *     --directory /abs/path/to/project \
 *     --planner-model <providerA/model> \
 *     --critic-model <providerB/model> \
 *     [--spec-file <path>] [--parent-session <id>] \
 *     [--timeout-ms 600000]
 *
 * ralplan independence rule: planner and critic must run on models from
 * DIFFERENT providers.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { approvePlan } from '../workflows/approval';
import { createBunJournal } from '../workflows/journal';
import { runRalplan } from '../workflows/planning';
import type { WorkflowOutputReader } from '../workflows/planning-transport';
import {
  resolveWorkflowRoleProfile,
  type WorkflowAgentConfigSource,
} from '../workflows/profiles';
import type { V1ClientHost } from '../workflows/runtime/v1';
import { createV1SessionPort } from '../workflows/runtime/v1';

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function stringArg(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function required(args: Args, key: string): string {
  const value = stringArg(args, key);
  if (value === undefined) {
    console.error(`missing required flag --${key}`);
    process.exit(1);
  }
  return value;
}

function splitModel(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    console.error(`model '${ref}' must look like <providerID>/<modelID>`);
    process.exit(1);
  }
  return {
    providerID: ref.slice(0, slash),
    modelID: ref.slice(slash + 1),
  };
}

const DEMO_SPEC = `# Demo spec

## Goal
Document the durable workflow runtime in the plugin README.

## Constraints
- Markdown only; no source changes.
- Keep the new section under 30 lines.
`;

async function makeWaitForIdle(
  client: OpencodeClient,
  directory: string,
): Promise<
  (sessionID: string) => Promise<'terminal' | 'pending' | 'uncertain'>
> {
  return async (sessionID) => {
    try {
      const response = await client.session.status({
        query: { directory },
      });
      const live = (response.data ?? {}) as Record<string, unknown>;
      const entry = live[sessionID];
      // The live status map only describes active runners; an absent
      // session is idle, not unknown.
      if (entry === undefined) return 'terminal';
      const type = (entry as { type?: string }).type;
      return type === 'idle' ? 'terminal' : 'pending';
    } catch {
      return 'uncertain';
    }
  };
}

function adaptV1Client(client: OpencodeClient): V1ClientHost {
  type CreateBody = { title: string; parentID?: string };
  type PromptBody = {
    messageID?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    noReply?: boolean;
    parts: Array<{ type: 'text'; text: string }>;
  };
  return {
    session: {
      create: async (input) => {
        const record = input as {
          query: { directory: string };
          body: CreateBody;
        };
        return client.session.create({
          query: { directory: record.query.directory },
          body: record.body,
        });
      },
      get: async (input) => {
        const record = input as {
          path: { id: string };
          query: { directory: string };
        };
        return client.session.get({
          path: { id: record.path.id },
          query: { directory: record.query.directory },
        });
      },
      list: async (input) => {
        const record = input as { query: { directory: string } };
        return client.session.list({
          query: { directory: record.query.directory },
        });
      },
      messages: async (input) => {
        const record = input as {
          path: { id: string };
          query: { directory: string };
        };
        return client.session.messages({
          path: { id: record.path.id },
          query: { directory: record.query.directory },
        });
      },
      prompt: async (input) => {
        const record = input as {
          path: { id: string };
          query: { directory: string };
          body: PromptBody;
        };
        return client.session.prompt({
          path: { id: record.path.id },
          query: { directory: record.query.directory },
          body: record.body,
        });
      },
      abort: async (input) => {
        const record = input as { path: { id: string } };
        return client.session.abort({ path: { id: record.path.id } });
      },
    },
  };
}

function sdkOutputReader(
  client: OpencodeClient,
  directory: string,
): WorkflowOutputReader {
  return {
    async read(_operationId, sessionID) {
      const response = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      const messages = (response.data ?? []) as Array<{
        info?: { role?: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      const chunks: string[] = [];
      for (const message of messages) {
        if (message.info?.role !== 'assistant') continue;
        for (const part of message.parts ?? []) {
          if (part.type === 'text' && typeof part.text === 'string') {
            chunks.push(part.text);
          }
        }
      }
      return chunks.join('\n');
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const baseUrl = stringArg(args, 'base-url') ?? 'http://localhost:4096';
  const explicitDirectory = stringArg(args, 'directory');
  const directory = explicitDirectory ?? (await mkdtemp(join(tmpdir(), 'wf-sandbox-')));
  if (!explicitDirectory) console.log('sandbox directory:', directory);
  const client = createOpencodeClient({ baseUrl, directory });

  const plannerModelRef = required(args, 'planner-model');
  const criticModelRef = required(args, 'critic-model');
  const planner = splitModel(plannerModelRef);
  const critic = splitModel(criticModelRef);
  if (planner.providerID === critic.providerID) {
    console.error(
      'ralplan independence: planner and critic must use models from DIFFERENT providers',
    );
    process.exit(1);
  }

  const waitForIdle = await makeWaitForIdle(client, directory);
  const port = createV1SessionPort(adaptV1Client(client), {
    waitForIdle,
  });
  const probe = await port.probe();
  console.log('port probe:', probe);
  if (!probe.available) {
    console.error('v1 runtime port is not fully capable on this host');
    process.exit(1);
  }

  const plannerAgent = stringArg(args, 'planner-agent') ?? 'plan';
  const criticAgent = stringArg(args, 'critic-agent') ?? 'oracle';
  const source: WorkflowAgentConfigSource = {
    agents: () => ({
      [plannerAgent]: { model: plannerModelRef },
      [criticAgent]: { model: criticModelRef },
    }),
  };
  const plannerProfile = resolveWorkflowRoleProfile(
    'planner',
    plannerAgent,
    source,
    [],
  );
  const criticProfile = resolveWorkflowRoleProfile(
    'critic',
    criticAgent,
    source,
    [],
  );

  const parentSessionID =
    stringArg(args, 'parent-session') ??
    (
      await client.session.create({
        query: { directory },
        body: { title: 'workflow-harness-parent' },
      })
    ).data?.id;
  if (!parentSessionID) {
    console.error('failed to obtain a parent session');
    process.exit(1);
  }
  console.log('parent session:', parentSessionID);

  const specPath = stringArg(args, 'spec-file');
  const specText = specPath ? await Bun.file(specPath).text() : DEMO_SPEC;
  const timeoutMs = Number(stringArg(args, 'timeout-ms') ?? 600_000);

  let baseCommit = stringArg(args, 'base-commit') ?? '';
  if (baseCommit === '') {
    try {
      baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory,
        encoding: 'utf8',
      }).trim();
    } catch {
      baseCommit = '0000000000000000000000000000000000000000';
    }
  }

  const plan = await runRalplan({
    planId: `harness-${Date.now()}`,
    parentSessionID,
    specText,
    specSha256: createHash('sha256').update(specText).digest('hex'),
    source: 'user-spec',
    baseCommit,
    plannerProfile,
    criticProfile,
    capabilityDigest: `sha256:${createHash('sha256')
      .update(`${plannerModelRef}\n${criticModelRef}`)
      .digest('hex')}`,
    workspace: {
      directory,
      canonical: directory,
      projectID: `harness-${createHash('sha1')
        .update(directory)
        .digest('hex')
        .slice(0, 12)}`,
    },
    expansionEnvelope: {
      maxAdditionalNodes: 2,
      allowedWritePaths: ['src/**'],
    },
    budget: {
      tokenBudget: 400_000,
      timeBudgetMs: timeoutMs,
      knownInputTokens: 2_000,
      responseAllowanceTokens: 16_000,
    },
    port,
    outputReader: sdkOutputReader(client, directory),
  });

  console.log('plan nodes:', plan.compiled.definition.nodes.length);
  console.log('definition digest:', plan.compiled.definitionDigest);
  console.log('critic verdict:', plan.review.verdict);
  for (const finding of plan.review.findings) {
    console.log('-', finding);
  }
  console.log('approval digest:', plan.approvalDigest);

  const journalDir = await mkdtemp(join(tmpdir(), 'workflow-harness-'));
  const journal = createBunJournal(join(journalDir, 'journal.sqlite'));
  const lease = journal.acquireLease(
    plan.compiled.definition.planId,
    'workflow-harness',
  );
  if (lease === null) {
    console.error(
      'journal lease unavailable for',
      plan.compiled.definition.planId,
    );
    journal.close();
    process.exit(1);
  }
  const approval = approvePlan(
    plan,
    {
      approvedDigest: plan.approvalDigest,
      approvedBy: 'workflow-harness',
      source: 'user-command',
    },
    { journal, lease },
  );
  console.log(
    'approval persisted:',
    approval.planId,
    'by',
    approval.approvedBy,
    '→',
    journalDir,
  );
  journal.close();
}

await main();
