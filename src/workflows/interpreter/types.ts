export const INTERPRETER_ABI_VERSION = 1;
export const QUICKJS_WASI_VERSION = '3.6.0';

export const DEFAULT_INTERPRETER_LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  checkpointBytes: 128 * 1024 * 1024,
  cpuBurstMs: 1_000,
  bridgeCallsPerBurst: 256,
} as const;

export type WorkflowIdentity = {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
};

export type InterpreterLimits = {
  readonly memoryBytes: number;
  readonly checkpointBytes: number;
  readonly cpuBurstMs: number;
  readonly bridgeCallsPerBurst: number;
};

export type WorkflowOperationKind = 'task' | 'tool' | 'callback';

export type WorkflowOperation = {
  readonly id: string;
  readonly kind: WorkflowOperationKind;
  readonly name: string;
  readonly input: unknown;
  readonly sequence: number;
};

export type ResolverEntry = {
  readonly operationId: string;
  readonly kind: WorkflowOperationKind;
  readonly name: string;
};

export type DeliveryEntry = {
  readonly operationId: string;
  readonly order: number;
};

export type InterpreterCheckpoint = {
  readonly formatVersion: 1;
  readonly bridgeAbiVersion: number;
  readonly quickjsWasiVersion: string;
  readonly wasmDigest: string;
  readonly configurationDigest: string;
  readonly sourceDigest: string;
  readonly identity: WorkflowIdentity;
  readonly vmSnapshot: Uint8Array;
  readonly pendingOperations: readonly WorkflowOperation[];
  readonly resolverMap: readonly ResolverEntry[];
  readonly deliveryMap: readonly DeliveryEntry[];
  readonly nextCallSequence: number;
};

export type InterpreterResult =
  | { readonly kind: 'completed'; readonly value: unknown }
  | {
      readonly kind: 'suspended';
      readonly checkpoint: InterpreterCheckpoint;
    };

export interface CheckpointCoordinator {
  acknowledgeCheckpoint(checkpoint: InterpreterCheckpoint): Promise<void>;
}

export type HostCallback = (input: unknown) => unknown | Promise<unknown>;

export type InterpreterOptions = {
  readonly identity: WorkflowIdentity;
  readonly coordinator: CheckpointCoordinator;
  readonly dispatch: (operation: WorkflowOperation) => Promise<void>;
  readonly moduleSources?: Readonly<Record<string, string>>;
  readonly approvedTools?: readonly string[];
  readonly callbacks?: Readonly<Record<string, HostCallback>>;
  readonly limits?: Partial<InterpreterLimits>;
  readonly frozenTimeMs?: number;
  readonly randomByte?: number;
};

export type RestoreInterpreterOptions = Omit<
  InterpreterOptions,
  'identity' | 'moduleSources' | 'approvedTools'
> & {
  readonly moduleSources?: Readonly<Record<string, string>>;
  readonly approvedTools?: readonly string[];
};

export type InterpreterErrorCode =
  | 'bridge_limit'
  | 'checkpoint_limit'
  | 'cpu_limit'
  | 'disposed'
  | 'guest_error'
  | 'memory_limit'
  | 'snapshot_incompatible'
  | 'worker_error';

export class InterpreterError extends Error {
  override readonly name: string = 'InterpreterError';

  constructor(
    readonly code: InterpreterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class SnapshotCompatibilityError extends InterpreterError {
  override readonly name = 'SnapshotCompatibilityError';

  constructor(message: string) {
    super('snapshot_incompatible', message);
  }
}
