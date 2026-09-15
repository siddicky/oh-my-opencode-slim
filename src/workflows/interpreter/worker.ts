import { vmFailure } from './failure';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { WorkflowVm } from './vm';

let workflowVm: WorkflowVm | undefined;

function respond(response: WorkerResponse): void {
  postMessage(response);
}

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    switch (request.kind) {
      case 'initialize': {
        workflowVm = new WorkflowVm(request.configuration);
        await workflowVm.initialize(request.checkpoint);
        respond({
          id: request.id,
          ok: true,
          workerId: request.configuration.workerId,
        });
        return;
      }
      case 'run': {
        const result = await requireVm().run(request.source);
        respond({ id: request.id, ok: true, result });
        return;
      }
      case 'deliver': {
        const result = await requireVm().deliver(
          request.operationId,
          request.value,
        );
        respond({ id: request.id, ok: true, result });
        return;
      }
      case 'dispose': {
        workflowVm?.dispose();
        workflowVm = undefined;
        respond({ id: request.id, ok: true });
        return;
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      const failure = vmFailure(error);
      respond({ id: request.id, ok: false, ...failure });
      return;
    }
    const failure = vmFailure(error);
    respond({ id: request.id, ok: false, ...failure });
  }
}

function requireVm(): WorkflowVm {
  if (!workflowVm) {
    throw new Error('interpreter worker is not initialized');
  }
  return workflowVm;
}
