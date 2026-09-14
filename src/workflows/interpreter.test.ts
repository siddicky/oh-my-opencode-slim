import { describe, expect, test } from 'bun:test';
import {
  type CheckpointCoordinator,
  createWorkflowInterpreter,
  DEFAULT_INTERPRETER_LIMITS,
  InterpreterError,
  restoreWorkflowInterpreter,
  SnapshotCompatibilityError,
  type WorkflowOperation,
} from './interpreter';

const immediateCoordinator: CheckpointCoordinator = {
  acknowledgeCheckpoint: async () => {},
};

describe('interpreter promise restore', () => {
  test('restores a pending task promise in a fresh worker', async () => {
    // Given a task call whose checkpoint must become durable before dispatch.
    const events: string[] = [];
    const coordinator: CheckpointCoordinator = {
      acknowledgeCheckpoint: async (checkpoint) => {
        events.push(`checkpoint:${checkpoint.pendingOperations[0]?.id}`);
      },
    };
    let dispatched: WorkflowOperation | undefined;
    const interpreter = await createWorkflowInterpreter({
      identity: { runId: 'run-1', nodeId: 'node-1', attempt: 2 },
      coordinator,
      dispatch: async (operation) => {
        dispatched = operation;
        events.push(`dispatch:${operation.id}`);
      },
    });

    // When the guest suspends on task(), then its VM is disposed and restored.
    const suspended = await interpreter.run(`
      globalThis.output = 'waiting';
      task({ role: 'executor' }).then((value) => {
        globalThis.output = value.message;
      });
    `);
    await interpreter.dispose();

    expect(suspended.kind).toBe('suspended');
    if (suspended.kind !== 'suspended') {
      throw new Error('expected suspended interpreter');
    }
    const restored = await restoreWorkflowInterpreter(suspended.checkpoint, {
      coordinator,
      dispatch: async () => {},
    });
    const resumed = await restored.deliver(dispatched?.id ?? '', {
      message: 'restored',
    });
    await restored.dispose();

    // Then the stable operation resumes exactly once in a different worker.
    expect(dispatched?.id).toBe('run-1:node-1:2:0');
    expect(events).toEqual([
      'checkpoint:run-1:node-1:2:0',
      'dispatch:run-1:node-1:2:0',
    ]);
    expect(restored.workerId).not.toBe(interpreter.workerId);
    expect(resumed).toEqual({ kind: 'completed', value: 'restored' });
  });

  test('re-registers named host callbacks before restored jobs resume', async () => {
    // Given a pending task whose continuation calls a named host callback.
    const first = await createWorkflowInterpreter({
      identity: { runId: 'run-callback', nodeId: 'node-callback', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      callbacks: { decorate: async () => 'unused-before-restore' },
    });
    const suspended = await first.run(`
      task({ value: 4 }).then(async (value) => {
        globalThis.output = await callbacks.decorate(value);
      });
    `);
    await first.dispose();
    if (suspended.kind !== 'suspended') {
      throw new Error('expected suspended interpreter');
    }
    let callbackInput: unknown;
    const restored = await restoreWorkflowInterpreter(suspended.checkpoint, {
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      callbacks: {
        decorate: async (input) => {
          callbackInput = input;
          return 'callback-after-restore';
        },
      },
    });

    // When the persisted task result is delivered to the fresh worker.
    const result = await restored.deliver(
      suspended.checkpoint.pendingOperations[0]?.id ?? '',
      { value: 9 },
    );
    await restored.dispose();

    // Then the rebound host callback receives the value and resumes the guest.
    expect(callbackInput).toEqual({ value: 9 });
    expect(result).toEqual({
      kind: 'completed',
      value: 'callback-after-restore',
    });
  });
});

describe('interpreter limits and incompatibility', () => {
  test('interrupts a runaway guest without blocking the host event loop', async () => {
    // Given a worker VM with a short CPU burst.
    const interpreter = await createWorkflowInterpreter({
      identity: { runId: 'run-loop', nodeId: 'node-loop', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      limits: { cpuBurstMs: 40 },
    });
    let hostTimerFired = false;
    const hostTimer = new Promise<void>((resolve) => {
      setTimeout(() => {
        hostTimerFired = true;
        resolve();
      }, 5);
    });

    // When untrusted code enters an infinite loop.
    const evaluation = interpreter
      .run('while (true) {}')
      .catch((error) => error);
    await hostTimer;
    const error = await evaluation;
    await interpreter.dispose();

    // Then the host timer fires and QuickJS reports the CPU limit.
    expect(hostTimerFired).toBe(true);
    if (!(error instanceof InterpreterError)) {
      throw error;
    }
    expect(error.code).toBe('cpu_limit');
  });

  test('rejects excessive QuickJS heap allocation', async () => {
    // Given a VM with a deliberately small heap ceiling.
    const interpreter = await createWorkflowInterpreter({
      identity: { runId: 'run-memory', nodeId: 'node-memory', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      limits: { memoryBytes: 2 * 1024 * 1024 },
    });

    // When the guest allocates beyond its heap allowance.
    const evaluation = interpreter.run(
      'globalThis.output = new ArrayBuffer(8 * 1024 * 1024);',
    );

    // Then the VM reports a typed memory-limit failure.
    const error = await evaluation.catch((failure) => failure);
    if (!(error instanceof InterpreterError)) {
      throw error;
    }
    expect(error.code).toBe('memory_limit');
    await interpreter.dispose();
  });

  test('denies modules outside the fixed approved source map', async () => {
    // Given a VM with one approved in-memory module and no ambient loader.
    const interpreter = await createWorkflowInterpreter({
      identity: { runId: 'run-import', nodeId: 'node-import', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      moduleSources: { approved: 'export const value = 42;' },
    });

    // When approved and denied module names are evaluated.
    const approved = await interpreter.run(
      "import { value } from 'approved'; globalThis.output = value;",
    );
    const denied = interpreter.run(
      "import value from 'node:fs'; globalThis.output = value;",
    );

    // Then only the fixed module source resolves.
    expect(approved).toEqual({ kind: 'completed', value: 42 });
    const deniedError = await denied.catch((error) => error);
    if (!(deniedError instanceof InterpreterError)) {
      throw deniedError;
    }
    expect(deniedError.code).toBe('guest_error');
    await interpreter.dispose();
  });

  test('rejects incompatible snapshots with a typed error', async () => {
    // Given a valid suspended checkpoint with a changed bridge ABI identity.
    const interpreter = await createWorkflowInterpreter({
      identity: { runId: 'run-snapshot', nodeId: 'node-snapshot', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
    });
    const suspended = await interpreter.run('task({ value: 1 });');
    await interpreter.dispose();
    if (suspended.kind !== 'suspended') {
      throw new Error('expected suspended interpreter');
    }
    const incompatible = {
      ...suspended.checkpoint,
      bridgeAbiVersion: suspended.checkpoint.bridgeAbiVersion + 1,
    };

    // When restoration validates the checkpoint envelope.
    const restoration = restoreWorkflowInterpreter(incompatible, {
      coordinator: immediateCoordinator,
      dispatch: async () => {},
    });

    // Then recovery stops instead of restarting the workflow source.
    await expect(restoration).rejects.toBeInstanceOf(
      SnapshotCompatibilityError,
    );
  });

  test('enforces bridge and serialized checkpoint ceilings', async () => {
    // Given separate VMs with low policy limits.
    const bridgeLimited = await createWorkflowInterpreter({
      identity: { runId: 'run-bridge', nodeId: 'node-bridge', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      limits: { bridgeCallsPerBurst: 2 },
    });
    const checkpointLimited = await createWorkflowInterpreter({
      identity: {
        runId: 'run-checkpoint',
        nodeId: 'node-checkpoint',
        attempt: 0,
      },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      limits: { checkpointBytes: 128 },
    });

    // When guest calls or snapshot bytes exceed their ceilings.
    const bridgeEvaluation = bridgeLimited.run('task(1); task(2); task(3);');
    const checkpointEvaluation = checkpointLimited.run('task(1);');

    // Then both policy breaches are typed and the production defaults stay fixed.
    const bridgeError = await bridgeEvaluation.catch((error) => error);
    const checkpointError = await checkpointEvaluation.catch((error) => error);
    if (!(bridgeError instanceof InterpreterError)) {
      throw bridgeError;
    }
    if (!(checkpointError instanceof InterpreterError)) {
      throw checkpointError;
    }
    expect(bridgeError.code).toBe('bridge_limit');
    expect(checkpointError.code).toBe('checkpoint_limit');
    expect(DEFAULT_INTERPRETER_LIMITS).toEqual({
      memoryBytes: 64 * 1024 * 1024,
      checkpointBytes: 128 * 1024 * 1024,
      cpuBurstMs: 1_000,
      bridgeCallsPerBurst: 256,
    });
    await bridgeLimited.dispose();
    await checkpointLimited.dispose();
  });

  test('freezes time timezone and randomness without ambient host APIs', async () => {
    // Given two isolated VMs with identical deterministic policy.
    const options = {
      identity: { runId: 'run-deterministic', nodeId: 'node-a', attempt: 0 },
      coordinator: immediateCoordinator,
      dispatch: async () => {},
      frozenTimeMs: 1_234_567_890_000,
    };
    const first = await createWorkflowInterpreter(options);
    const second = await createWorkflowInterpreter({
      ...options,
      identity: { ...options.identity, nodeId: 'node-b' },
    });
    const source = `
      globalThis.output = {
        now: Date.now(),
        timezone: new Date().getTimezoneOffset(),
        random: Math.random(),
        process: typeof process,
        fetch: typeof fetch,
        require: typeof require,
        bun: typeof Bun,
      };
    `;

    // When both workers evaluate the same guest source.
    const firstResult = await first.run(source);
    const secondResult = await second.run(source);
    await first.dispose();
    await second.dispose();

    // Then replay inputs match and host capabilities remain absent.
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({
      kind: 'completed',
      value: {
        now: 1_234_567_890_000,
        timezone: 0,
        random: expect.any(Number),
        process: 'undefined',
        fetch: 'undefined',
        require: 'undefined',
        bun: 'undefined',
      },
    });
  });
});
