import * as fs from 'node:fs/promises';
import type { InterviewConfig } from '../config';
import {
  normalizeOutputFolder,
  parseFrontmatter,
  resolveExistingInterviewPath,
} from '../interview/document';
import type { InterviewSessionRuntime } from '../interview/runtime';
import {
  createInterviewService,
  type InterviewFinalSpecEvent,
} from '../interview/service';
import type { InterviewState } from '../interview/types';
import { createInternalAgentTextPart } from '../utils';
import {
  DeepInterviewError,
  type DeepInterviewErrorCode,
  type DeepInterviewSpecManifest,
  finalizeSpecManifest,
  listFinalizedManifests,
  loadFinalizedManifest,
} from './interview-manifest';
import {
  buildDeepKickoffPrompt,
  buildDeepResumePrompt,
} from './interview-prompts';

export type { DeepInterviewErrorCode, DeepInterviewSpecManifest };
export { buildDeepKickoffPrompt, buildDeepResumePrompt, DeepInterviewError };

export interface DeepInterviewOptions {
  directory: string;
  config?: InterviewConfig;
  runtime: InterviewSessionRuntime;
  interviewerAgent?: string;
  onFinalized?: (manifest: DeepInterviewSpecManifest) => void;
}

export interface DeepInterviewStart {
  interviewId: string;
  injected: string;
  resumed: boolean;
}

export function createDeepInterview(options: DeepInterviewOptions): {
  service: ReturnType<typeof createInterviewService>;
  startOrResume(input: {
    sessionID: string;
    goal: string;
  }): Promise<DeepInterviewStart>;
  getInterviewState(interviewId: string): Promise<InterviewState>;
  listFinalizedManifests(): Promise<DeepInterviewSpecManifest[]>;
  loadFinalizedManifest(specPath: string): Promise<DeepInterviewSpecManifest>;
} {
  const { directory, runtime } = options;
  if (!runtime) {
    throw new DeepInterviewError(
      'interview_unavailable',
      'deep interview requires an interview session runtime; the host does not expose one',
    );
  }
  const interviewerAgent = options.interviewerAgent ?? 'orchestrator';
  const outputFolder = normalizeOutputFolder(
    options.config?.outputFolder ?? 'interview',
  );
  const maxQuestions = options.config?.maxQuestions ?? 2;

  const persistFinalSpec = async (event: InterviewFinalSpecEvent) => {
    const manifest = await finalizeSpecManifest(event, interviewerAgent);
    options.onFinalized?.(manifest);
  };

  const service = createInterviewService(
    { directory } as never,
    options.config,
    {
      runtime,
      interviewerAgent,
      onFinalSpecPersisted: persistFinalSpec,
    },
  );

  async function readOwnerSession(
    markdownPath: string,
  ): Promise<string | null> {
    try {
      const frontmatter = parseFrontmatter(
        await fs.readFile(markdownPath, 'utf8'),
      );
      const sessionID = frontmatter?.sessionID;
      return typeof sessionID === 'string' && sessionID ? sessionID : null;
    } catch {
      return null;
    }
  }

  async function startOrResume(input: {
    sessionID: string;
    goal: string;
  }): Promise<DeepInterviewStart> {
    const goal = input.goal.trim();
    if (!goal) {
      throw new DeepInterviewError(
        'invalid_goal',
        'deep-interview requires a non-empty goal',
      );
    }

    const resumePath = resolveExistingInterviewPath(
      directory,
      outputFolder,
      goal,
    );
    if (resumePath) {
      const owner = await readOwnerSession(resumePath);
      if (owner && owner !== input.sessionID) {
        throw new DeepInterviewError(
          'ownership_mismatch',
          `Interview document ${resumePath} is owned by session ${owner}, not ${input.sessionID}`,
        );
      }
    }

    const output = {
      parts: [] as Array<{ type: string; text?: string }>,
    };
    await service.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: input.sessionID,
        arguments: goal,
      },
      output,
    );
    const interviewId = service.getActiveInterviewId(input.sessionID);
    if (!interviewId) {
      if ((output.parts[0]?.text ?? '').includes('already owned')) {
        throw new DeepInterviewError(
          'ownership_mismatch',
          `Interview document for goal '${goal}' is owned by another session`,
        );
      }
      throw new DeepInterviewError(
        'interview_unavailable',
        `deep interview did not start for goal '${goal}'`,
      );
    }

    const injected = resumePath
      ? buildDeepResumePrompt(
          (await service.getInterviewState(interviewId)).document,
          maxQuestions,
        )
      : buildDeepKickoffPrompt(goal, maxQuestions);
    output.parts.length = 0;
    output.parts.push(createInternalAgentTextPart(injected));
    return { interviewId, injected, resumed: Boolean(resumePath) };
  }

  return {
    service,
    startOrResume,
    getInterviewState: (interviewId) => service.getInterviewState(interviewId),
    listFinalizedManifests: () =>
      listFinalizedManifests(directory, outputFolder),
    loadFinalizedManifest,
  };
}
