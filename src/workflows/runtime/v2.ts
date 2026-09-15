import type { V2Session } from '../../v2/types';
import type { PortProbe, UsageReport } from '../contracts';
import {
  acceptedData,
  isRecord,
  ModelVerificationError,
  matchesModel,
  type NativeDispatchResult,
  type NativeSessionPort,
  type NativeSessionRequest,
  readString,
  type SessionPortOptions,
  UnattendedRuntimeUnsupportedError,
  unwrapEntity,
} from './port';

// allow: SIZE_OK — one versioned adapter keeps all host call shapes auditable.

export interface V2SessionPortOptions extends SessionPortOptions {
  readonly supportsCreateMetadata?: boolean;
}

export type V2RuntimeSessionHost = Pick<
  V2Session,
  'create' | 'get' | 'list' | 'prompt' | 'wait' | 'interrupt'
>;

type OperationRecord = {
  readonly request: NativeSessionRequest;
  sessionID?: string;
};

const REQUIRED_METHODS = [
  'create',
  'get',
  'list',
  'prompt',
  'wait',
  'interrupt',
] as const;

export function createV2SessionPort(
  session: V2RuntimeSessionHost,
  options: V2SessionPortOptions = {},
): NativeSessionPort {
  const operations = new Map<string, OperationRecord>();

  function missingCapabilities(): readonly string[] {
    return REQUIRED_METHODS.filter(
      (method) => typeof session[method] !== 'function',
    );
  }

  async function probe(): Promise<PortProbe> {
    const available = missingCapabilities().length === 0;
    return {
      available,
      supportsReconcile:
        typeof session.get === 'function' && typeof session.list === 'function',
      supportsUsage: typeof session.get === 'function',
      supportsCancel:
        typeof session.interrupt === 'function' &&
        typeof session.wait === 'function',
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
    if (!session.create || !session.get || !session.prompt) {
      throw new UnattendedRuntimeUnsupportedError(request.operationId, [
        'v2 session dispatch',
      ]);
    }
    const model = {
      id: request.profile.model.modelID,
      providerID: request.profile.model.providerID,
      ...(request.profile.model.variant
        ? { variant: request.profile.model.variant }
        : {}),
    };
    const location = {
      directory: request.workspace.directory,
      ...(request.workspace.workspaceID
        ? { workspaceID: request.workspace.workspaceID }
        : {}),
      project: {
        id: request.workspace.projectID,
        directory: request.workspace.canonical,
        canonical: request.workspace.canonical,
      },
    };
    let createResponse: unknown;
    try {
      createResponse = await session.create({
        id: request.operationId,
        parentID: request.parentSessionID,
        agent: request.profile.agent,
        model,
        location,
        ...(options.supportsCreateMetadata
          ? { metadata: { workflowOperationID: request.operationId } }
          : {}),
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
        'OpenCode v2 create response did not include a session ID.',
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

    let getResponse: unknown;
    try {
      getResponse = await session.get({ sessionID });
    } catch (error) {
      if (error instanceof Error) {
        throw new ModelVerificationError(
          request.operationId,
          'OpenCode v2 effective model verification failed.',
          { cause: error },
        );
      }
      throw new ModelVerificationError(
        request.operationId,
        'OpenCode v2 effective model verification failed.',
      );
    }
    const current = unwrapEntity(responseData(getResponse));
    const actualModel =
      current && isRecord(current.model) ? current.model : undefined;
    if (!matchesModel(actualModel, request.profile.model, 'id')) {
      throw new ModelVerificationError(
        request.operationId,
        'OpenCode v2 did not confirm the approved provider/model before work.',
      );
    }

    let promptResponse: unknown;
    try {
      promptResponse = await session.prompt({
        sessionID,
        id: request.operationId,
        prompt: { text: request.prompt },
        delivery: 'queue',
        resume: true,
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
    if (!operation || !session.get || !session.list)
      return 'uncertain' as const;
    if (operation.sessionID) {
      try {
        const found = unwrapEntity(
          responseData(await session.get({ sessionID: operation.sessionID })),
        );
        return found && matchesV2Identity(found, operation.request)
          ? 'found'
          : 'missing';
      } catch (error) {
        if (error instanceof Error) return 'uncertain';
        return 'uncertain';
      }
    }
    try {
      const listed = responseItems(
        await session.list({
          directory: operation.request.workspace.directory,
          parentID: operation.request.parentSessionID,
        }),
      );
      const matches = listed.filter((item) =>
        matchesV2Identity(item, operation.request),
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
    const sessionID = operations.get(operationId)?.sessionID;
    if (!sessionID || !session.get) return 'unavailable';
    const info = unwrapEntity(responseData(await session.get({ sessionID })));
    const tokens = info && isRecord(info.tokens) ? info.tokens : undefined;
    if (!tokens) return 'unavailable';
    const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
    return {
      inputTokens: numberField(tokens, 'input'),
      outputTokens: numberField(tokens, 'output'),
      reasoningTokens: numberField(tokens, 'reasoning'),
      cachedTokens: cache
        ? numberField(cache, 'read') + numberField(cache, 'write')
        : 0,
    };
  }

  async function wait(operationId: string) {
    const sessionID = operations.get(operationId)?.sessionID;
    if (!sessionID || !session.wait) return 'uncertain' as const;
    try {
      if (!isSuccessfulResponse(await session.wait({ sessionID }))) {
        return 'uncertain';
      }
      return 'terminal' as const;
    } catch (error) {
      if (error instanceof Error) return 'uncertain';
      return 'uncertain';
    }
  }

  async function cancel(operationId: string) {
    const sessionID = operations.get(operationId)?.sessionID;
    if (!sessionID || !session.interrupt || !session.wait) {
      return 'unsupported' as const;
    }
    try {
      if (!isSuccessfulResponse(await session.interrupt({ sessionID }))) {
        return 'pending';
      }
      if (!isSuccessfulResponse(await session.wait({ sessionID }))) {
        return 'pending';
      }
      return 'cancelled' as const;
    } catch (error) {
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
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data) || !Array.isArray(data.data)) return [];
  return data.data.filter(isRecord);
}

function matchesV2Identity(
  info: Record<string, unknown>,
  request: NativeSessionRequest,
): boolean {
  const metadata = isRecord(info.metadata) ? info.metadata : undefined;
  const location = isRecord(info.location) ? info.location : undefined;
  const project =
    location && isRecord(location.project) ? location.project : undefined;
  const stableIdentity =
    readString(info, 'id') === request.operationId ||
    readString(metadata ?? {}, 'workflowOperationID') === request.operationId;
  return (
    stableIdentity &&
    readString(info, 'parentID') === request.parentSessionID &&
    readString(location ?? {}, 'directory') === request.workspace.directory &&
    readString(project ?? {}, 'canonical') === request.workspace.canonical
  );
}

function numberField(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : 0;
}
