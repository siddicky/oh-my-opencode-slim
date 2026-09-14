import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type HostFunction, QuickJS } from 'quickjs-wasi';
import type { WorkerConfiguration } from './protocol';
import {
  INTERPRETER_ABI_VERSION,
  type InterpreterCheckpoint,
  QUICKJS_WASI_VERSION,
} from './types';

export function digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function configurationDigest(configuration: WorkerConfiguration): string {
  const modules = Object.entries(configuration.moduleSources).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return digest(
    JSON.stringify({
      modules,
      approvedTools: [...configuration.approvedTools].sort(),
      callbackNames: [...configuration.callbackNames].sort(),
      frozenTimeMs: configuration.frozenTimeMs,
      randomByte: configuration.randomByte,
    }),
  );
}

function bridgeBootstrap(configuration: WorkerConfiguration): string {
  const tools = configuration.approvedTools.map(
    (name) =>
      `${JSON.stringify(name)}: input => __workflowCall('tool', ${JSON.stringify(name)}, input)`,
  );
  const callbacks = configuration.callbackNames.map(
    (name) =>
      `${JSON.stringify(name)}: input => __workflowCall('callback', ${JSON.stringify(name)}, input)`,
  );
  return `
    globalThis.__workflowResolvers = Object.create(null);
    globalThis.__workflowCall = (kind, name, input) => {
      const id = globalThis.__workflowHostIntent(kind, name, input);
      return new Promise((resolve, reject) => {
        globalThis.__workflowResolvers[id] = { resolve, reject };
      });
    };
    globalThis.task = input => globalThis.__workflowCall('task', 'task', input);
    globalThis.tools = Object.freeze({ ${tools.join(',')} });
    globalThis.callbacks = Object.freeze({ ${callbacks.join(',')} });
  `;
}

export type Sandbox = {
  readonly vm: QuickJS;
  readonly wasmDigest: string;
  readonly configurationDigest: string;
};

export async function createSandbox(
  configuration: WorkerConfiguration,
  hostIntent: HostFunction,
  interrupted: () => boolean,
  checkpoint?: InterpreterCheckpoint,
): Promise<Sandbox> {
  const wasm = await readFile(
    new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')),
  );
  const wasmDigest = digest(wasm);
  const currentConfigurationDigest = configurationDigest(configuration);
  if (
    checkpoint &&
    (checkpoint.formatVersion !== 1 ||
      checkpoint.bridgeAbiVersion !== INTERPRETER_ABI_VERSION ||
      checkpoint.quickjsWasiVersion !== QUICKJS_WASI_VERSION ||
      checkpoint.wasmDigest !== wasmDigest ||
      checkpoint.configurationDigest !== currentConfigurationDigest)
  ) {
    throw new Error(
      'interpreter checkpoint identity is incompatible with this runtime',
    );
  }
  const options = {
    wasm,
    memoryLimit: configuration.limits.memoryBytes,
    interruptHandler: interrupted,
    moduleLoader: {
      normalize: (_baseName: string, specifier: string) => specifier,
      load: (name: string) => {
        const source = configuration.moduleSources[name];
        if (source === undefined) {
          throw new Error(`module import denied: ${name}`);
        }
        return source;
      },
    },
    timezoneOffset: 0,
    wasi: (memory: WebAssembly.Memory) => ({
      clock_time_get: (
        _clockId: number,
        _precision: bigint,
        resultPointer: number,
      ) => {
        new DataView(memory.buffer).setBigUint64(
          resultPointer,
          BigInt(configuration.frozenTimeMs) * 1_000_000n,
          true,
        );
        return 0;
      },
      random_get: (bufferPointer: number, bufferLength: number) => {
        new Uint8Array(memory.buffer, bufferPointer, bufferLength).fill(
          configuration.randomByte,
        );
        return 0;
      },
    }),
  };
  const vm = checkpoint
    ? await QuickJS.restore(
        QuickJS.deserializeSnapshot(checkpoint.vmSnapshot),
        options,
      )
    : await QuickJS.create(options);
  if (checkpoint) {
    vm.registerHostCallback('__workflowHostIntent', hostIntent);
  } else {
    using hostIntentHandle = vm.newFunction('__workflowHostIntent', hostIntent);
    vm.setProp(vm.global, '__workflowHostIntent', hostIntentHandle);
    vm.evalCode(bridgeBootstrap(configuration)).dispose();
  }
  return { vm, wasmDigest, configurationDigest: currentConfigurationDigest };
}
