import type { PortProbe, UsageReport } from '../contracts';
import {
  acceptedData,
  isRecord,
  ModelVerificationError,
  matchesModel,
  type NativeDispatchResult,
  type NativeSessionPort,
  type NativeSessionRequest,
  RuntimeAdapterError,
  readString,
  type SessionPortOptions,
  UnattendedRuntimeUnsupportedError,
  unwrapEntity,
} from './port';

// allow: SIZE_OK — one versioned adapter keeps all host call shapes auditable.

type HostCall = (input: Record<string, unknown>) => Promise<unknown>;

export interface V1SessionHost {
  readonly create?: HostCall;
  readonly get?: HostCall;
  readonly list?: HostCall;
  readonly messages?: HostCall;
  readonly prompt?: HostCall;
  readonly abort?: HostCall;
}

export interface V1ClientHost {
  readonly session?: V1SessionHost;
}

export interface V1SessionPortOptions extends SessionPortOptions {
  readonly waitForIdle?: (
    sessionID: string,
  ) => Promise<'terminal' | 'pending' | 'uncertain'>;
  /**
   * Bound for idle observation in `wait()`/`cancel()`. When set, an
   * unresolved `waitForIdle` (or a stuck abort call) cannot outlive this
   * deadline: the session is aborted and a `wait_timeout` error naming the
   * operation is thrown. Unset preserves the legacy unbounded await.
   */
  readonly waitTimeoutMs?: number;
}

const waitTimeoutSentinel = Symbol('v1-wait-timeout');

function isWaitTimeout(error: unknown): boolean {
  return error === waitTimeoutSentinel;
}

function waitTimeoutError(
  operationId: string,
  timeoutMs: number,
): RuntimeAdapterError {
  return new RuntimeAdapterError(
    'wait_timeout',
    operationId,
    `workflow ${operationId} session wait timed out after ${timeoutMs}ms; session aborted`,
  );
}

async function withWaitTimeout<T>(
  task: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return task;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(waitTimeoutSentinel);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type OperationRecord = {
  readonly request: NativeSessionRequest;
  sessionID?: string;
};

const REQUIRED_METHODS = [
  'create',
  'get',
  'list',
  'messages',
  'prompt',
  'abort',
] as const;

export function createV1SessionPort(
  client: V1ClientHost,
  options: V1SessionPortOptions = {},
): NativeSessionPort {
  const session = client.session;
  const operations = new Map<string, OperationRecord>();

  function missingCapabilities(): readonly string[] {
    const missing = REQUIRED_METHODS.filter(
      (method) => typeof session?.[method] !== 'function',
    );
    return options.waitForIdle
      ? missing
      : [...missing, 'observed session wait'];
  }

  async function probe(): Promise<PortProbe> {
    const available = missingCapabilities().length === 0;
    return {
      available,
      supportsReconcile:
        typeof session?.get === 'function' &&
        typeof session.list === 'function',
      supportsUsage: typeof session?.messages === 'function',
      supportsCancel:
        typeof session?.abort === 'function' && Boolean(options.waitForIdle),
    };
  }

  async function assertUnattendedReady(
    operationId = 'workflow-preflight',
  ): Promise<void> {
    const missing = missingCapabilities();
    if (missing.length > 0) {
      throw new UnattendedRuntimeUnsupportedError(operationId, missing);
    }
  }

  async function dispatch(
    request: NativeSessionRequest,
  ): Promise<NativeDispatchResult> {
    await assertUnattendedReady(request.operationId);
    operations.set(request.operationId, { request });
    const active = session;
    if (!active?.create || !active.prompt || !active.messages) {
      throw new UnattendedRuntimeUnsupportedError(request.operationId, [
        'v1 session dispatch',
      ]);
    }

    let createResponse: unknown;
    try {
      createResponse = await active.create({
        query: { directory: request.workspace.directory },
        body: {
          title: `workflow:${request.operationId}`,
          parentID: request.parentSessionID,
        },
      });
    } catch (error) {
      if (error instanceof Error)
        return { state: 'uncertain', stage: 'create' };
      return { state: 'uncertain', stage: 'create' };
    }
    const created = unwrapEntity(
      acceptedData(createResponse, request.operationId, 'create'),
    );
    const sessionID = created ? readString(created, 'id') : undefined;
    if (!sessionID) {
      throw new ModelVerificationError(
        request.operationId,
        'OpenCode v1 create response did not include a session ID.',
      );
    }
    const operation = operations.get(request.operationId);
    if (operation) operation.sessionID = sessionID;
    try {
      await options.recordSession?.(request.operationId, sessionID);
    } catch (error) {
      if (error instanceof Error) {
        return { state: 'uncertain', stage: 'create', sessionID };
      }
      return { state: 'uncertain', stage: 'create', sessionID };
    }

    const model = {
      providerID: request.profile.model.providerID,
      modelID: request.profile.model.modelID,
    };
    let profileResponse: unknown;
    try {
      profileResponse = await active.prompt({
        path: { id: sessionID },
        query: { directory: request.workspace.directory },
        body: {
          messageID: `msg_workflow_${request.operationId}:profile`,
          agent: request.profile.agent,
          model,
          noReply: true,
          parts: [{ type: 'text', text: 'profile verification' }],
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        return { state: 'uncertain', stage: 'prompt', sessionID };
      }
      return { state: 'uncertain', stage: 'prompt', sessionID };
    }
    acceptedData(profileResponse, request.operationId, 'prompt');

    let messagesResponse: unknown;
    try {
      messagesResponse = await active.messages({
        path: { id: sessionID },
        query: { directory: request.workspace.directory },
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new ModelVerificationError(
          request.operationId,
          'OpenCode v1 effective model verification failed.',
          { cause: error },
        );
      }
      throw new ModelVerificationError(
        request.operationId,
        'OpenCode v1 effective model verification failed.',
      );
    }
    const messages = responseItems(messagesResponse);
    const profileMessage = messages.find((item) => {
      const info = isRecord(item.info) ? item.info : undefined;
      return (
        readString(info ?? {}, 'id') ===
        `msg_workflow_${request.operationId}:profile`
      );
    });
    const info =
      profileMessage && isRecord(profileMessage.info)
        ? profileMessage.info
        : undefined;
    const actualModel = info && isRecord(info.model) ? info.model : undefined;
    if (
      !matchesModel(
        actualModel,
        {
          providerID: request.profile.model.providerID,
          modelID: request.profile.model.modelID,
        },
        'modelID',
      )
    ) {
      throw new ModelVerificationError(
        request.operationId,
        'OpenCode v1 did not confirm the approved provider/model before work.',
      );
    }

    let promptResponse: unknown;
    try {
      promptResponse = await active.prompt({
        path: { id: sessionID },
        query: { directory: request.workspace.directory },
        body: {
          messageID: `msg_workflow_${request.operationId}`,
          agent: request.profile.agent,
          model,
          parts: [{ type: 'text', text: request.prompt }],
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        return { state: 'uncertain', stage: 'prompt', sessionID };
      }
      return { state: 'uncertain', stage: 'prompt', sessionID };
    }
    acceptedData(promptResponse, request.operationId, 'prompt');
    return { state: 'prompted', sessionID };
  }

  async function reconcile(operationId: string) {
    const operation = operations.get(operationId);
    if (!operation || !session?.get || !session.list)
      return 'uncertain' as const;
    if (operation.sessionID) {
      try {
        const response = await session.get({
          path: { id: operation.sessionID },
          query: { directory: operation.request.workspace.directory },
        });
        const found = unwrapEntity(responseData(response));
        return found && matchesV1Identity(found, operation.request)
          ? 'found'
          : 'missing';
      } catch (error) {
        if (error instanceof Error) return 'uncertain';
        return 'uncertain';
      }
    }
    try {
      const response = await session.list({
        query: { directory: operation.request.workspace.directory },
      });
      const matches = responseItems(response).filter((item) =>
        matchesV1Identity(item, operation.request),
      );
      if (matches.length === 0) return 'missing';
      if (matches.length !== 1) return 'uncertain';
      operation.sessionID = readString(matches[0] ?? {}, 'id');
      return operation.sessionID ? 'found' : 'uncertain';
    } catch (error) {
      if (error instanceof Error) return 'uncertain';
      return 'uncertain';
    }
  }

  async function usage(
    operationId: string,
  ): Promise<UsageReport | 'unavailable'> {
    const operation = operations.get(operationId);
    if (!operation?.sessionID || !session?.messages) return 'unavailable';
    const response = await session.messages({
      path: { id: operation.sessionID },
      query: { directory: operation.request.workspace.directory },
    });
    return aggregateUsage(responseItems(response));
  }

  async function abortSession(sessionID: string): Promise<void> {
    if (!session?.abort) return;
    try {
      await withWaitTimeout(
        session.abort({ path: { id: sessionID } }),
        options.waitTimeoutMs,
      );
    } catch {
      // Best-effort: the timeout error below already reports the outcome.
    }
  }

  async function wait(operationId: string) {
    const sessionID = operations.get(operationId)?.sessionID;
    if (!sessionID || !options.waitForIdle) return 'uncertain' as const;
    const timeoutMs = options.waitTimeoutMs;
    try {
      return await withWaitTimeout(options.waitForIdle(sessionID), timeoutMs);
    } catch (error) {
      if (timeoutMs !== undefined && isWaitTimeout(error)) {
        await abortSession(sessionID);
        throw waitTimeoutError(operationId, timeoutMs);
      }
      throw error;
    }
  }

  async function cancel(operationId: string) {
    const sessionID = operations.get(operationId)?.sessionID;
    if (!sessionID || !session?.abort || !options.waitForIdle) {
      return 'unsupported' as const;
    }
    const timeoutMs = options.waitTimeoutMs;
    try {
      const response = await withWaitTimeout(
        session.abort({ path: { id: sessionID } }),
        timeoutMs,
      );
      if (!isSuccessfulResponse(response)) return 'pending';
      return (await withWaitTimeout(
        options.waitForIdle(sessionID),
        timeoutMs,
      )) === 'terminal'
        ? ('cancelled' as const)
        : ('pending' as const);
    } catch (error) {
      if (timeoutMs !== undefined && isWaitTimeout(error)) {
        throw waitTimeoutError(operationId, timeoutMs);
      }
      if (error instanceof Error) return 'pending';
      return 'pending';
    }
  }

  return {
    probe,
    assertUnattendedReady,
    dispatch,
    reconcile,
    usage,
    wait,
    cancel,
  };
}

function responseData(response: unknown): unknown {
  if (!isRecord(response) || response.error !== undefined) return undefined;
  return response.data;
}

function isSuccessfulResponse(response: unknown): boolean {
  return (
    isRecord(response) && response.error === undefined && 'data' in response
  );
}

function responseItems(response: unknown): readonly Record<string, unknown>[] {
  const data = responseData(response);
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord);
}

function matchesV1Identity(
  session: Record<string, unknown>,
  request: NativeSessionRequest,
): boolean {
  const projectID = readString(session, 'projectID');
  return (
    readString(session, 'title') === `workflow:${request.operationId}` &&
    readString(session, 'parentID') === request.parentSessionID &&
    readString(session, 'directory') === request.workspace.directory &&
    (projectID === undefined || projectID === request.workspace.projectID)
  );
}

function numberField(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : 0;
}

function aggregateUsage(
  items: readonly Record<string, unknown>[],
): UsageReport {
  const seen = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedTokens = 0;
  for (const item of items) {
    const info = isRecord(item.info) ? item.info : undefined;
    const id = info ? readString(info, 'id') : undefined;
    const tokens = info && isRecord(info.tokens) ? info.tokens : undefined;
    if (!id || !tokens || seen.has(id)) continue;
    seen.add(id);
    inputTokens += numberField(tokens, 'input');
    outputTokens += numberField(tokens, 'output');
    reasoningTokens += numberField(tokens, 'reasoning');
    const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
    if (cache)
      cachedTokens += numberField(cache, 'read') + numberField(cache, 'write');
  }
  return { inputTokens, outputTokens, reasoningTokens, cachedTokens };
}
