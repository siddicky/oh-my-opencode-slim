import type { WorkerRequest, WorkerResponse } from './protocol';
import {
  InterpreterError,
  type InterpreterLimits,
  SnapshotCompatibilityError,
} from './types';

type PendingRequest = {
  readonly resolve: (response: WorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type WorkerRequestPayload = WorkerRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export class WorkerTransport {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 0;
  private disposed = false;

  constructor(private readonly limits: InterpreterLimits) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) {
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(event.data.id);
      request.resolve(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.rejectPending(
        new InterpreterError('worker_error', event.message || 'worker crashed'),
      );
    };
  }

  request(
    request: WorkerRequestPayload,
    timeoutMs: number,
  ): Promise<WorkerResponse> {
    if (this.disposed) {
      return Promise.reject(
        new InterpreterError('disposed', 'interpreter disposed'),
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.worker.terminate();
        this.disposed = true;
        reject(
          new InterpreterError(
            'cpu_limit',
            `interpreter CPU burst exceeded ${this.limits.cpuBurstMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...request });
    }).then((response) => {
      if (response.ok) {
        return response;
      }
      if (response.code === 'snapshot_incompatible') {
        throw new SnapshotCompatibilityError(response.message);
      }
      throw new InterpreterError(response.code, response.message);
    });
  }

  terminate(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.worker.terminate();
    this.rejectPending(
      new InterpreterError('disposed', 'interpreter disposed'),
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
