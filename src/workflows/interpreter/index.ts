import type { WorkerConfiguration, WorkerResponse } from './protocol';
import { WorkerTransport } from './transport';
import {
  DEFAULT_INTERPRETER_LIMITS,
  type HostCallback,
  type InterpreterCheckpoint,
  InterpreterError,
  type InterpreterLimits,
  type InterpreterOptions,
  type InterpreterResult,
  type RestoreInterpreterOptions,
  type WorkflowOperation,
} from './types';

let nextWorkerSequence = 0;

function mergeLimits(limits?: Partial<InterpreterLimits>): InterpreterLimits {
  const merged = { ...DEFAULT_INTERPRETER_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InterpreterError(
        'worker_error',
        `interpreter limit ${name} must be a positive integer`,
      );
    }
  }
  return merged;
}

export class WorkflowInterpreter {
  readonly workerId: string;
  private readonly transport: WorkerTransport;
  private readonly dispatched = new Set<string>();

  private constructor(
    private readonly options: InterpreterOptions,
    private readonly limits: InterpreterLimits,
    workerId: string,
    checkpoint?: InterpreterCheckpoint,
  ) {
    this.workerId = workerId;
    this.transport = new WorkerTransport(limits);
    if (checkpoint) {
      for (const operation of checkpoint.pendingOperations) {
        this.dispatched.add(operation.id);
      }
    }
  }

  static async create(
    options: InterpreterOptions,
  ): Promise<WorkflowInterpreter> {
    const limits = mergeLimits(options.limits);
    const workerId = `workflow-worker-${nextWorkerSequence}`;
    nextWorkerSequence += 1;
    const interpreter = new WorkflowInterpreter(
      { ...options, limits },
      limits,
      workerId,
    );
    await interpreter.initialize();
    return interpreter;
  }

  static async restore(
    checkpoint: InterpreterCheckpoint,
    options: RestoreInterpreterOptions,
  ): Promise<WorkflowInterpreter> {
    const limits = mergeLimits(options.limits);
    const workerId = `workflow-worker-${nextWorkerSequence}`;
    nextWorkerSequence += 1;
    const fullOptions: InterpreterOptions = {
      ...options,
      identity: checkpoint.identity,
      limits,
    };
    const interpreter = new WorkflowInterpreter(
      fullOptions,
      limits,
      workerId,
      checkpoint,
    );
    await interpreter.initialize(checkpoint);
    return interpreter;
  }

  async run(source: string): Promise<InterpreterResult> {
    const response = await this.transport.request(
      { kind: 'run', source },
      this.executionTimeoutMs,
    );
    return this.processResult(this.requireResult(response));
  }

  async deliver(
    operationId: string,
    value: unknown,
  ): Promise<InterpreterResult> {
    const response = await this.transport.request(
      { kind: 'deliver', operationId, value },
      this.executionTimeoutMs,
    );
    return this.processResult(this.requireResult(response));
  }

  async dispose(): Promise<void> {
    if (this.transport.isDisposed) {
      return;
    }
    try {
      await this.transport.request({ kind: 'dispose' }, 250);
    } finally {
      this.transport.terminate();
    }
  }

  private async initialize(checkpoint?: InterpreterCheckpoint): Promise<void> {
    const configuration: WorkerConfiguration = {
      workerId: this.workerId,
      identity: this.options.identity,
      limits: this.limits,
      moduleSources: this.options.moduleSources ?? {},
      approvedTools: this.options.approvedTools ?? [],
      callbackNames: Object.keys(this.options.callbacks ?? {}).sort(),
      frozenTimeMs: this.options.frozenTimeMs ?? 1_700_000_000_000,
      randomByte: this.options.randomByte ?? 0x42,
    };
    await this.transport.request(
      { kind: 'initialize', configuration, checkpoint },
      10_000,
    );
  }

  private async processResult(
    initialResult: InterpreterResult,
  ): Promise<InterpreterResult> {
    let result = initialResult;
    while (result.kind === 'suspended') {
      await this.options.coordinator.acknowledgeCheckpoint(result.checkpoint);
      const callback = result.checkpoint.pendingOperations.find(
        (operation) =>
          operation.kind === 'callback' && !this.dispatched.has(operation.id),
      );
      const externalOperations = result.checkpoint.pendingOperations.filter(
        (operation) =>
          operation.kind !== 'callback' && !this.dispatched.has(operation.id),
      );
      for (const operation of externalOperations) {
        this.dispatched.add(operation.id);
        await this.options.dispatch(operation);
      }
      if (!callback) {
        return result;
      }
      this.dispatched.add(callback.id);
      const value = await this.invokeCallback(callback);
      const response = await this.transport.request(
        { kind: 'deliver', operationId: callback.id, value },
        this.executionTimeoutMs,
      );
      result = this.requireResult(response);
    }
    return result;
  }

  private async invokeCallback(operation: WorkflowOperation): Promise<unknown> {
    const callback: HostCallback | undefined =
      this.options.callbacks?.[operation.name];
    if (!callback) {
      throw new InterpreterError(
        'guest_error',
        `host callback is not registered: ${operation.name}`,
      );
    }
    return callback(operation.input);
  }

  private get executionTimeoutMs(): number {
    return this.limits.cpuBurstMs + 5_000;
  }

  private requireResult(response: WorkerResponse): InterpreterResult {
    if (!response.ok || !response.result) {
      throw new InterpreterError(
        'worker_error',
        'interpreter worker returned no result',
      );
    }
    return response.result;
  }
}

export function createWorkflowInterpreter(
  options: InterpreterOptions,
): Promise<WorkflowInterpreter> {
  return WorkflowInterpreter.create(options);
}

export function restoreWorkflowInterpreter(
  checkpoint: InterpreterCheckpoint,
  options: RestoreInterpreterOptions,
): Promise<WorkflowInterpreter> {
  return WorkflowInterpreter.restore(checkpoint, options);
}

export type {
  CheckpointCoordinator,
  DeliveryEntry,
  HostCallback,
  InterpreterCheckpoint,
  InterpreterLimits,
  InterpreterOptions,
  InterpreterResult,
  ResolverEntry,
  RestoreInterpreterOptions,
  WorkflowIdentity,
  WorkflowOperation,
  WorkflowOperationKind,
} from './types';
export {
  DEFAULT_INTERPRETER_LIMITS,
  INTERPRETER_ABI_VERSION,
  InterpreterError,
  QUICKJS_WASI_VERSION,
  SnapshotCompatibilityError,
} from './types';
