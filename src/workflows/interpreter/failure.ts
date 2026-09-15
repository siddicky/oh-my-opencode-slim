import type { InterpreterErrorCode } from './types';

export class VmFailure extends Error {
  override readonly name = 'VmFailure';

  constructor(
    readonly code: Exclude<InterpreterErrorCode, 'disposed'>,
    message: string,
  ) {
    super(message);
  }
}

export function vmFailure(error: unknown): {
  readonly code: Exclude<InterpreterErrorCode, 'disposed'>;
  readonly message: string;
} {
  if (error instanceof VmFailure) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'worker_error', message: error.message };
  }
  return {
    code: 'worker_error',
    message: 'unknown interpreter worker failure',
  };
}
