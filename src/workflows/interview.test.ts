import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InterviewSessionRuntime } from '../interview/runtime';
import type { InterviewMessage } from '../interview/types';
import {
  buildDeepKickoffPrompt,
  createDeepInterview,
  DeepInterviewError,
  type DeepInterviewSpecManifest,
} from './interview';

const BASE_URL = 'http://127.0.0.1:43211';
const FINAL_SPEC_TEXT = '# Introduction\n\nA polished final specification.';

interface Harness {
  directory: string;
  messages: InterviewMessage[];
  continueAgents: Array<string | undefined>;
  deep: ReturnType<typeof createDeepInterview>;
  finalized: DeepInterviewSpecManifest[];
}

async function createHarness(
  interviewerAgent = 'planner-agent',
): Promise<Harness> {
  const directory = await fs.mkdtemp('/tmp/workflows-deep-interview-');
  const messages: InterviewMessage[] = [];
  const continueAgents: Array<string | undefined> = [];
  const runtime: InterviewSessionRuntime = {
    messages: async () => messages,
    notify: async () => {},
    continue: async (_sessionID, _text, _model, agent) => {
      continueAgents.push(agent);
    },
    rename: async () => {},
  };
  const finalized: DeepInterviewSpecManifest[] = [];
  const deep = createDeepInterview({
    directory,
    runtime,
    interviewerAgent,
    onFinalized: (manifest) => finalized.push(manifest),
  });
  deep.service.setBaseUrlResolver(async () => BASE_URL);
  return { directory, messages, continueAgents, deep, finalized };
}

function pushStateQuestion(messages: InterviewMessage[]): void {
  messages.push({
    info: { role: 'assistant' },
    parts: [
      {
        type: 'text',
        text: '<interview_state>{"summary":"Draft","title":"deep-app","questions":[{"id":"q-1","question":"Platform?","options":["Web"]}]}</interview_state>',
      },
    ],
  });
}

async function idleEvent(harness: Harness, sessionID: string): Promise<void> {
  await harness.deep.service.handleEvent({
    event: {
      type: 'session.status',
      properties: { sessionID, status: { type: 'idle' } },
    },
  });
}

async function sha256OfFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

describe('workflows deep interview', () => {
  test('deep interview finalized handoff persists hashed manifest once', async () => {
    const harness = await createHarness();
    const start = await harness.deep.startOrResume({
      sessionID: 'ses_deep',
      goal: 'Deep app',
    });
    expect(start.resumed).toBe(false);
    // Routing decision: the deep kickoff prompt is dispatched, not the
    // default /interview kickoff.
    expect(start.injected).toBe(buildDeepKickoffPrompt('Deep app'));

    pushStateQuestion(harness.messages);
    await harness.deep.service.getInterviewState(start.interviewId);
    // User answer collection stays interactive through the service.
    await harness.deep.service.submitAnswers(start.interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    // Explicit interviewer role selection reaches the runtime.
    expect(harness.continueAgents).toEqual(['planner-agent']);

    await idleEvent(harness, 'ses_deep');
    await harness.deep.service.handleNudgeAction(
      start.interviewId,
      'confirm-complete',
    );
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: FINAL_SPEC_TEXT }],
    });
    await idleEvent(harness, 'ses_deep');
    const state = await harness.deep.service.getInterviewState(
      start.interviewId,
    );
    expect(state.document).toContain('A polished final specification.');

    expect(harness.finalized).toHaveLength(1);
    const manifest = harness.finalized[0];
    expect(manifest.interviewId).toBe(start.interviewId);
    expect(manifest.sessionID).toBe('ses_deep');
    expect(manifest.interviewerAgent).toBe('planner-agent');
    const diskHash = await sha256OfFile(manifest.specPath);
    expect(manifest.specSha256).toBe(diskHash);
    expect(manifest.specBytes).toBe(
      (await fs.readFile(manifest.specPath)).length,
    );
    expect(
      JSON.parse(
        await fs.readFile(`${manifest.specPath}.manifest.json`, 'utf8'),
      ),
    ).toEqual(manifest);

    // Restart: a fresh module instance over the same directory recovers the
    // identical verified manifest.
    const revived = createDeepInterview({
      directory: harness.directory,
      runtime: {
        messages: async () => [],
        notify: async () => {},
        continue: async () => {},
        rename: async () => {},
      },
      interviewerAgent: 'planner-agent',
    });
    const recovered = await revived.listFinalizedManifests();
    expect(recovered).toHaveLength(1);
    expect(JSON.stringify(recovered[0])).toBe(JSON.stringify(manifest));
    expect(await revived.loadFinalizedManifest(manifest.specPath)).toEqual(
      manifest,
    );

    // Duplicate completion events never re-finalize or overwrite.
    await idleEvent(harness, 'ses_deep');
    await harness.deep.service.getInterviewState(start.interviewId);
    expect(harness.finalized).toHaveLength(1);
    expect(await sha256OfFile(manifest.specPath)).toBe(diskHash);

    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  test('deep interview partial stream rejected before completion event', async () => {
    const harness = await createHarness();
    const start = await harness.deep.startOrResume({
      sessionID: 'ses_stream',
      goal: 'Stream app',
    });
    pushStateQuestion(harness.messages);
    await harness.deep.service.getInterviewState(start.interviewId);
    await harness.deep.service.submitAnswers(start.interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await idleEvent(harness, 'ses_stream');
    await harness.deep.service.handleNudgeAction(
      start.interviewId,
      'confirm-complete',
    );

    // Stream prefix arrives mid-generation: busy session, no completion
    // event has marked the final answer ready yet.
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: '# Introduction\n\nA partial str' }],
    });
    const midStream = await harness.deep.service.getInterviewState(
      start.interviewId,
    );
    expect(midStream.document).not.toContain('A partial str');
    expect(harness.finalized).toHaveLength(0);
    await expect(harness.deep.listFinalizedManifests()).resolves.toHaveLength(
      0,
    );

    // The prefix did not consume the finalization round: the complete clean
    // answer still finalizes with the full spec.
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: FINAL_SPEC_TEXT }],
    });
    await idleEvent(harness, 'ses_stream');
    await harness.deep.service.getInterviewState(start.interviewId);
    expect(harness.finalized).toHaveLength(1);
    const manifest = harness.finalized[0];
    const document = await fs.readFile(manifest.specPath, 'utf8');
    expect(document).toContain('A polished final specification.');
    expect(document).not.toContain('A partial str');
    expect(manifest.specSha256).toBe(await sha256OfFile(manifest.specPath));

    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  test('deep interview rejects cross-session resume without mutating the document', async () => {
    const directory = await fs.mkdtemp('/tmp/workflows-deep-owned-');
    const documentPath = path.join(directory, 'interview', 'owned.md');
    await fs.mkdir(path.dirname(documentPath), { recursive: true });
    await fs.writeFile(documentPath, '# Owned\n\nDraft.', 'utf8');

    const owner = createDeepInterview({
      directory,
      runtime: {
        messages: async () => [],
        notify: async () => {},
        continue: async () => {},
        rename: async () => {},
      },
      interviewerAgent: 'planner-agent',
    });
    owner.service.setBaseUrlResolver(async () => BASE_URL);
    await owner.service.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: 'ses_owner',
        arguments: documentPath,
      },
      { parts: [] },
    );

    const stranger = createDeepInterview({
      directory,
      runtime: {
        messages: async () => [],
        notify: async () => {},
        continue: async () => {},
        rename: async () => {},
      },
      interviewerAgent: 'planner-agent',
    });
    stranger.service.setBaseUrlResolver(async () => BASE_URL);
    const owned = await fs.readFile(documentPath, 'utf8');
    try {
      await stranger.startOrResume({
        sessionID: 'ses_stranger',
        goal: documentPath,
      });
      throw new Error('expected ownership_mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(DeepInterviewError);
      expect((error as DeepInterviewError).code).toBe('ownership_mismatch');
    }
    expect(await fs.readFile(documentPath, 'utf8')).toBe(owned);

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('deep interview requires a session runtime and a goal', async () => {
    expect(() =>
      createDeepInterview({
        directory: '/tmp/unused-deep-interview',
        runtime: undefined as never,
      }),
    ).toThrow(DeepInterviewError);

    const harness = await createHarness();
    const blankError = await harness.deep
      .startOrResume({ sessionID: 'ses_blank', goal: '  ' })
      .catch((error: unknown) => error);
    expect(blankError).toBeInstanceOf(DeepInterviewError);
    expect((blankError as DeepInterviewError).code).toBe('invalid_goal');
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  test('deep kickoff prompt covers the four clarification axes', () => {
    const prompt = buildDeepKickoffPrompt('Deep app');
    expect(prompt).toContain('requirements');
    expect(prompt).toContain('constraints');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('dependencies');
  });
});
