import type {
  InterpreterCheckpoint,
  InterpreterLimits,
  InterpreterResult,
  WorkflowIdentity,
} from './types';

export type WorkerConfiguration = {
  readonly workerId: string;
  readonly identity: WorkflowIdentity;
  readonly limits: InterpreterLimits;
  readonly moduleSources: Readonly<Record<string, string>>;
  readonly approvedTools: readonly string[];
  readonly callbackNames: readonly string[];
  readonly frozenTimeMs: number;
  readonly randomByte: number;
};

export type WorkerRequest =
  | {
      readonly id: number;
      readonly kind: 'initialize';
      readonly configuration: WorkerConfiguration;
      readonly checkpoint?: InterpreterCheckpoint;
    }
  | { readonly id: number; readonly kind: 'run'; readonly source: string }
  | {
      readonly id: number;
      readonly kind: 'deliver';
      readonly operationId: string;
      readonly value: unknown;
    }
  | { readonly id: number; readonly kind: 'dispose' };

export type WorkerSuccess = {
  readonly id: number;
  readonly ok: true;
  readonly workerId?: string;
  readonly result?: InterpreterResult;
};

export type WorkerFailure = {
  readonly id: number;
  readonly ok: false;
  readonly code:
    | 'bridge_limit'
    | 'checkpoint_limit'
    | 'cpu_limit'
    | 'guest_error'
    | 'memory_limit'
    | 'snapshot_incompatible'
    | 'worker_error';
  readonly message: string;
};

export type WorkerResponse = WorkerSuccess | WorkerFailure;
