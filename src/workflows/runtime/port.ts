import type { NativeToolPort, PortProbe, SessionPort } from '../contracts';

export type RuntimeFailureCode =
  | 'unsupported_method'
  | 'rejected_admission'
  | 'ambiguous_response_loss'
  | 'model_verification_failed';

export class RuntimeAdapterError extends Error {
  override readonly name: string = 'RuntimeAdapterError';

  constructor(
    readonly code: RuntimeFailureCode,
    readonly operationId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class UnattendedRuntimeUnsupportedError extends RuntimeAdapterError {
  readonly name = 'UnattendedRuntimeUnsupportedError';

  constructor(
    operationId: string,
    readonly missing: readonly string[],
  ) {
    super(
      'unsupported_method',
      operationId,
      `Unattended workflow execution is unavailable: host lacks ${missing.join(', ')}. Upgrade OpenCode or run this workflow interactively.`,
    );
  }
}

export class RejectedAdmissionError extends RuntimeAdapterError {
  readonly name = 'RejectedAdmissionError';

  constructor(
    operationId: string,
    stage: 'create' | 'prompt',
    detail: unknown,
  ) {
    super(
      'rejected_admission',
      operationId,
      `OpenCode rejected workflow ${stage} admission: ${describeUnknown(detail)}`,
    );
  }
}

export class ModelVerificationError extends RuntimeAdapterError {
  readonly name = 'ModelVerificationError';

  constructor(operationId: string, message: string, options?: ErrorOptions) {
    super('model_verification_failed', operationId, message, options);
  }
}

export interface NativeModelProfile {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export interface NativeRoleProfile {
  readonly agent: string;
  readonly model: NativeModelProfile;
}

export interface NativeWorkspaceIdentity {
  readonly directory: string;
  readonly canonical: string;
  readonly projectID: string;
  readonly workspaceID?: string;
}

export interface NativeSessionRequest {
  readonly operationId: string;
  readonly parentSessionID: string;
  readonly workspace: NativeWorkspaceIdentity;
  readonly profile: NativeRoleProfile;
  readonly prompt: string;
}

export type NativeDispatchResult =
  | { readonly state: 'prompted'; readonly sessionID: string }
  | {
      readonly state: 'uncertain';
      readonly stage: 'create' | 'prompt';
      readonly sessionID?: string;
    };

export interface NativeSessionPort extends SessionPort {
  assertUnattendedReady(operationId?: string): Promise<void>;
  dispatch(request: NativeSessionRequest): Promise<NativeDispatchResult>;
  wait(operationId: string): Promise<'terminal' | 'pending' | 'uncertain'>;
}

export interface SessionPortOptions {
  readonly recordSession?: (
    operationId: string,
    sessionID: string,
  ) => Promise<void>;
}

export const UNAVAILABLE_NATIVE_TOOL_PORT: NativeToolPort = {
  async probe(): Promise<PortProbe> {
    return {
      available: false,
      supportsReconcile: false,
      supportsUsage: false,
      supportsCancel: false,
    };
  },
  async reconcile() {
    return 'uncertain';
  },
  async usage() {
    return 'unavailable';
  },
  async cancel() {
    return 'unsupported';
  },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function acceptedData(
  response: unknown,
  operationId: string,
  stage: 'create' | 'prompt',
): unknown {
  if (!isRecord(response)) {
    throw new RejectedAdmissionError(operationId, stage, response);
  }
  if ('error' in response && response.error !== undefined) {
    throw new RejectedAdmissionError(operationId, stage, response.error);
  }
  if (!('data' in response)) {
    throw new RejectedAdmissionError(operationId, stage, response);
  }
  return response.data;
}

export function unwrapEntity(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.data) ? value.data : value;
}

export function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function matchesModel(
  actual: Record<string, unknown> | undefined,
  approved: NativeModelProfile,
  modelKey: 'id' | 'modelID',
): boolean {
  if (!actual) return false;
  if (
    readString(actual, 'providerID') !== approved.providerID ||
    readString(actual, modelKey) !== approved.modelID
  ) {
    return false;
  }
  return (
    approved.variant === undefined ||
    readString(actual, 'variant') === approved.variant
  );
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError) return 'unserializable host response';
    throw error;
  }
}
