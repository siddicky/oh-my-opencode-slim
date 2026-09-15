import {
  EvalFlags,
  JSException,
  type JSValueHandle,
  type QuickJS,
} from 'quickjs-wasi';
import {
  CheckpointLimitError,
  createCheckpoint,
  restoreCheckpointMetadata,
} from './checkpoint';
import { VmFailure } from './failure';
import type { WorkerConfiguration } from './protocol';
import { createSandbox, digest } from './sandbox';
import type {
  DeliveryEntry,
  InterpreterCheckpoint,
  InterpreterResult,
  WorkflowOperation,
  WorkflowOperationKind,
} from './types';

export class WorkflowVm {
  private vm: QuickJS | undefined;
  private sourceDigest = digest('');
  private nextCallSequence = 0;
  private nextDeliveryOrder = 0;
  private bridgeCalls = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private readonly pendingOperations = new Map<string, WorkflowOperation>();
  private readonly deliveries = new Map<string, DeliveryEntry>();
  private wasmDigest = '';
  private configurationDigest = '';

  constructor(private readonly configuration: WorkerConfiguration) {}

  async initialize(checkpoint?: InterpreterCheckpoint): Promise<void> {
    try {
      const sandbox = await createSandbox(
        this.configuration,
        this.handleIntent,
        () => performance.now() >= this.deadline,
        checkpoint,
      );
      this.vm = sandbox.vm;
      this.wasmDigest = sandbox.wasmDigest;
      this.configurationDigest = sandbox.configurationDigest;
      if (checkpoint) {
        this.restoreMetadata(checkpoint);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw this.normalizeError(error, checkpoint !== undefined);
      }
      throw this.normalizeError(error, checkpoint !== undefined);
    }
  }

  async run(source: string): Promise<InterpreterResult> {
    this.sourceDigest = digest(source);
    this.beginBurst();
    const vm = this.requireVm();
    try {
      using modulePromise = vm.evalCode(
        source,
        '<workflow>',
        EvalFlags.TYPE_MODULE,
      );
      vm.executePendingJobs();
      const settledPromise = vm.resolvePromise(modulePromise);
      vm.executePendingJobs();
      const settled = await settledPromise;
      if ('error' in settled) {
        const message = settled.error.toString();
        settled.error.dispose();
        throw this.guestFailure(message);
      }
      settled.value.dispose();
      return this.result();
    } catch (error) {
      if (error instanceof Error) {
        throw this.normalizeError(error, false);
      }
      throw this.normalizeError(error, false);
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
    }
  }

  async deliver(
    operationId: string,
    value: unknown,
  ): Promise<InterpreterResult> {
    const operation = this.pendingOperations.get(operationId);
    if (!operation) {
      throw new VmFailure(
        'guest_error',
        `unknown or already delivered operation: ${operationId}`,
      );
    }
    this.beginBurst();
    const vm = this.requireVm();
    try {
      using resolvers = vm.global.getProp('__workflowResolvers');
      using resolverEntry = resolvers.getProp(operationId);
      using resolve = resolverEntry.getProp('resolve');
      using argument = vm.hostToHandle(value);
      vm.callFunction(resolve, vm.undefined, argument).dispose();
      vm.evalCode(
        `delete globalThis.__workflowResolvers[${JSON.stringify(operationId)}]`,
      ).dispose();
      this.pendingOperations.delete(operationId);
      this.deliveries.set(operationId, {
        operationId,
        order: this.nextDeliveryOrder,
      });
      this.nextDeliveryOrder += 1;
      vm.executePendingJobs();
      return this.result();
    } catch (error) {
      if (error instanceof Error) {
        throw this.normalizeError(error, false);
      }
      throw this.normalizeError(error, false);
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
    }
  }

  dispose(): void {
    this.vm?.dispose();
    this.vm = undefined;
  }

  private readonly handleIntent = (
    kindHandle: JSValueHandle,
    nameHandle: JSValueHandle,
    inputHandle: JSValueHandle,
  ): JSValueHandle => {
    this.bridgeCalls += 1;
    if (this.bridgeCalls > this.configuration.limits.bridgeCallsPerBurst) {
      throw new VmFailure(
        'bridge_limit',
        `bridge call limit exceeded: ${this.configuration.limits.bridgeCallsPerBurst}`,
      );
    }
    const vm = this.requireVm();
    const kind = kindHandle.toString();
    if (kind !== 'task' && kind !== 'tool' && kind !== 'callback') {
      throw new VmFailure('guest_error', `unsupported bridge kind: ${kind}`);
    }
    const sequence = this.nextCallSequence;
    const operation: WorkflowOperation = {
      id: `${this.configuration.identity.runId}:${this.configuration.identity.nodeId}:${this.configuration.identity.attempt}:${sequence}`,
      kind: kind satisfies WorkflowOperationKind,
      name: nameHandle.toString(),
      input: vm.dump(inputHandle),
      sequence,
    };
    this.nextCallSequence += 1;
    this.pendingOperations.set(operation.id, operation);
    return vm.newString(operation.id);
  };

  private result(): InterpreterResult {
    if (this.pendingOperations.size > 0) {
      return { kind: 'suspended', checkpoint: this.checkpoint() };
    }
    const vm = this.requireVm();
    using output = vm.global.getProp('output');
    return { kind: 'completed', value: vm.dump(output) };
  }

  private checkpoint(): InterpreterCheckpoint {
    return createCheckpoint({
      vm: this.requireVm(),
      configuration: this.configuration,
      wasmDigest: this.wasmDigest,
      configurationDigest: this.configurationDigest,
      sourceDigest: this.sourceDigest,
      nextCallSequence: this.nextCallSequence,
      pendingOperations: this.pendingOperations,
      deliveries: this.deliveries,
    });
  }

  private restoreMetadata(checkpoint: InterpreterCheckpoint): void {
    this.sourceDigest = checkpoint.sourceDigest;
    this.nextCallSequence = checkpoint.nextCallSequence;
    this.nextDeliveryOrder = restoreCheckpointMetadata(
      checkpoint,
      this.pendingOperations,
      this.deliveries,
    );
  }

  private beginBurst(): void {
    this.bridgeCalls = 0;
    this.deadline = performance.now() + this.configuration.limits.cpuBurstMs;
  }

  private requireVm(): QuickJS {
    if (!this.vm) {
      throw new VmFailure('worker_error', 'QuickJS VM is not initialized');
    }
    return this.vm;
  }

  private normalizeError(error: unknown, restoring: boolean): VmFailure {
    if (error instanceof VmFailure) {
      return error;
    }
    if (error instanceof CheckpointLimitError) {
      return new VmFailure('checkpoint_limit', error.message);
    }
    if (error instanceof JSException) {
      const message = error.message;
      error.dispose();
      return this.guestFailure(message);
    }
    if (
      error instanceof Error &&
      /interrupted|out of memory|allocation|bridge call limit/i.test(
        error.message,
      )
    ) {
      return this.guestFailure(error.message);
    }
    if (restoring && error instanceof Error) {
      return new VmFailure('snapshot_incompatible', error.message);
    }
    if (error instanceof Error) {
      return new VmFailure('worker_error', error.message);
    }
    return new VmFailure('worker_error', 'unknown interpreter worker failure');
  }

  private guestFailure(message: string): VmFailure {
    if (/interrupted/i.test(message)) {
      return new VmFailure('cpu_limit', message);
    }
    if (/out of memory|allocation/i.test(message)) {
      return new VmFailure('memory_limit', message);
    }
    if (/bridge call limit/i.test(message)) {
      return new VmFailure('bridge_limit', message);
    }
    return new VmFailure('guest_error', message);
  }
}
