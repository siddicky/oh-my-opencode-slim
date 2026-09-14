import { describe, expect, mock, test } from 'bun:test';
import {
  type NativeSessionRequest,
  RejectedAdmissionError,
  UNAVAILABLE_NATIVE_TOOL_PORT,
  UnattendedRuntimeUnsupportedError,
} from './runtime/port';
import { createV1SessionPort } from './runtime/v1';
import { createV2SessionPort } from './runtime/v2';

const request = {
  operationId: 'op_run_node_1',
  parentSessionID: 'ses_parent',
  workspace: {
    directory: '/tmp/attempt',
    canonical: '/repo',
    projectID: 'project-1',
    workspaceID: 'workspace-1',
  },
  profile: {
    agent: 'executor',
    model: {
      providerID: 'approved-provider',
      modelID: 'approved-model',
      variant: 'high',
    },
  },
  prompt: 'Implement the approved node.',
} satisfies NativeSessionRequest;

describe('native profile dispatch', () => {
  test('v1 records the session before nested profile and work prompts', async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> =
      [];
    const client = {
      session: {
        create: mock(async (input: unknown) => {
          calls.push({ method: 'create', input });
          return {
            data: {
              id: 'ses_v1',
              parentID: 'ses_parent',
              directory: '/repo',
              title: 'workflow:op_run_node_1',
            },
          };
        }),
        get: mock(async () => ({ data: { id: 'ses_v1' } })),
        list: mock(async () => ({ data: [] })),
        messages: mock(async (input: unknown) => {
          calls.push({ method: 'messages', input });
          return {
            data: [
              {
                info: {
                  id: 'msg_workflow_op_run_node_1:profile',
                  role: 'user',
                  model: {
                    providerID: 'approved-provider',
                    modelID: 'approved-model',
                  },
                },
                parts: [],
              },
            ],
          };
        }),
        prompt: mock(async (input: unknown) => {
          calls.push({ method: 'prompt', input });
          return { data: {} };
        }),
        abort: mock(async () => ({ data: true })),
      },
    };
    const port = createV1SessionPort(client, {
      waitForIdle: async () => 'terminal',
      recordSession: async (_operationId, sessionID) => {
        calls.push({ method: 'record', input: sessionID });
      },
    });

    const result = await port.dispatch(request);

    expect(result).toEqual({ state: 'prompted', sessionID: 'ses_v1' });
    expect(calls.map((entry) => entry.method)).toEqual([
      'create',
      'record',
      'prompt',
      'messages',
      'prompt',
    ]);
    expect(calls[0]?.input).toEqual({
      query: { directory: '/tmp/attempt' },
      body: {
        title: 'workflow:op_run_node_1',
        parentID: 'ses_parent',
      },
    });
    expect(calls[2]?.input).toMatchObject({
      path: { id: 'ses_v1' },
      query: { directory: '/tmp/attempt' },
      body: {
        messageID: 'msg_workflow_op_run_node_1:profile',
        agent: 'executor',
        noReply: true,
        model: {
          providerID: 'approved-provider',
          modelID: 'approved-model',
        },
      },
    });
    expect(calls[4]?.input).toEqual({
      path: { id: 'ses_v1' },
      query: { directory: '/tmp/attempt' },
      body: {
        messageID: 'msg_workflow_op_run_node_1',
        agent: 'executor',
        model: {
          providerID: 'approved-provider',
          modelID: 'approved-model',
        },
        parts: [{ type: 'text', text: request.prompt }],
      },
    });
  });

  test('v2 uses flat native calls and verifies model before prompting', async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> =
      [];
    const info = {
      id: request.operationId,
      parentID: request.parentSessionID,
      model: {
        id: 'approved-model',
        providerID: 'approved-provider',
        variant: 'high',
      },
      location: {
        directory: '/tmp/attempt',
        project: { id: 'project-1', directory: '/repo', canonical: '/repo' },
      },
      metadata: { workflowOperationID: request.operationId },
      tokens: {
        input: 3,
        output: 5,
        reasoning: 2,
        cache: { read: 7, write: 11 },
      },
    };
    const session = {
      create: mock(async (input: unknown) => {
        calls.push({ method: 'create', input });
        return { data: info };
      }),
      get: mock(async (input: unknown) => {
        calls.push({ method: 'get', input });
        return { data: info };
      }),
      list: mock(async (input: unknown) => {
        calls.push({ method: 'list', input });
        return { data: [info] };
      }),
      prompt: mock(async (input: unknown) => {
        calls.push({ method: 'prompt', input });
        return { data: { admittedSeq: 1 } };
      }),
      wait: mock(async (input: unknown) => {
        calls.push({ method: 'wait', input });
        return { data: undefined };
      }),
      interrupt: mock(async (input: unknown) => {
        calls.push({ method: 'interrupt', input });
        return { data: undefined };
      }),
    };
    const port = createV2SessionPort(session, {
      supportsCreateMetadata: true,
      recordSession: async (_operationId, sessionID) => {
        calls.push({ method: 'record', input: sessionID });
      },
    });

    expect(await port.dispatch(request)).toEqual({
      state: 'prompted',
      sessionID: request.operationId,
    });
    expect(calls.slice(0, 4).map((entry) => entry.method)).toEqual([
      'create',
      'record',
      'get',
      'prompt',
    ]);
    expect(calls[0]?.input).toEqual({
      id: request.operationId,
      parentID: 'ses_parent',
      agent: 'executor',
      model: {
        id: 'approved-model',
        providerID: 'approved-provider',
        variant: 'high',
      },
      location: {
        directory: '/tmp/attempt',
        workspaceID: 'workspace-1',
        project: { id: 'project-1', directory: '/repo', canonical: '/repo' },
      },
      metadata: { workflowOperationID: request.operationId },
    });
    expect(calls[3]?.input).toEqual({
      sessionID: request.operationId,
      id: request.operationId,
      prompt: { text: request.prompt },
      delivery: 'queue',
      resume: true,
    });
    expect(await port.usage(request.operationId)).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
      cachedTokens: 18,
    });
    expect(await port.cancel(request.operationId)).toBe('cancelled');
    expect(calls.some((entry) => entry.method === 'interrupt')).toBe(true);
    expect(calls.some((entry) => entry.method === 'wait')).toBe(true);
  });
});

describe('native ambiguous admission and switch failure', () => {
  test('lost create acknowledgement is uncertain and is never retried', async () => {
    const create = mock(async () => {
      throw new Error('connection reset after write');
    });
    const list = mock(async () => ({
      data: [
        {
          id: request.operationId,
          parentID: request.parentSessionID,
          metadata: { workflowOperationID: request.operationId },
          location: {
            directory: request.workspace.directory,
            project: { canonical: request.workspace.canonical },
          },
        },
      ],
    }));
    const port = createV2SessionPort({
      create,
      get: mock(async () => ({ data: {} })),
      list,
      prompt: mock(async () => ({ data: {} })),
      wait: mock(async () => ({ data: undefined })),
      interrupt: mock(async () => ({ data: undefined })),
    });

    expect(await port.dispatch(request)).toEqual({
      state: 'uncertain',
      stage: 'create',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await port.reconcile(request.operationId)).toBe('found');
    expect(list).toHaveBeenCalledWith({
      directory: request.workspace.directory,
      parentID: request.parentSessionID,
    });
  });

  test('effective model mismatch fails closed before the work prompt', async () => {
    const prompt = mock(async () => ({ data: {} }));
    const port = createV2SessionPort({
      create: mock(async () => ({ data: { id: request.operationId } })),
      get: mock(async () => ({
        data: {
          id: request.operationId,
          model: { id: 'wrong-model', providerID: 'approved-provider' },
        },
      })),
      list: mock(async () => ({ data: [] })),
      prompt,
      wait: mock(async () => ({ data: undefined })),
      interrupt: mock(async () => ({ data: undefined })),
    });

    await expect(port.dispatch(request)).rejects.toMatchObject({
      code: 'model_verification_failed',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  test('explicit host rejection is distinct from response loss', async () => {
    const port = createV2SessionPort({
      create: mock(async () => ({ data: { id: request.operationId } })),
      get: mock(async () => ({
        data: {
          id: request.operationId,
          model: {
            id: 'approved-model',
            providerID: 'approved-provider',
            variant: 'high',
          },
        },
      })),
      list: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({ error: { status: 409 } })),
      wait: mock(async () => ({ data: undefined })),
      interrupt: mock(async () => ({ data: undefined })),
    });

    await expect(port.dispatch(request)).rejects.toBeInstanceOf(
      RejectedAdmissionError,
    );
  });

  test('interrupt rejection remains pending instead of claiming cancellation', async () => {
    const info = {
      id: request.operationId,
      model: {
        id: 'approved-model',
        providerID: 'approved-provider',
        variant: 'high',
      },
    };
    const wait = mock(async () => ({ data: undefined }));
    const port = createV2SessionPort({
      create: mock(async () => ({ data: info })),
      get: mock(async () => ({ data: info })),
      list: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({ data: { admittedSeq: 1 } })),
      wait,
      interrupt: mock(async () => ({ error: { status: 409 } })),
    });
    await port.dispatch(request);

    expect(await port.cancel(request.operationId)).toBe('pending');
    expect(wait).not.toHaveBeenCalled();
  });

  test('reduced hosts reject unattended launch while native tools stay unavailable', async () => {
    const port = createV1SessionPort(
      { session: {} },
      {
        waitForIdle: async () => 'terminal',
      },
    );

    await expect(port.assertUnattendedReady()).rejects.toBeInstanceOf(
      UnattendedRuntimeUnsupportedError,
    );
    expect(await UNAVAILABLE_NATIVE_TOOL_PORT.probe()).toEqual({
      available: false,
      supportsReconcile: false,
      supportsUsage: false,
      supportsCancel: false,
    });
  });
});
