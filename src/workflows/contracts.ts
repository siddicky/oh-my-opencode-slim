export const WORKFLOW_ROLE_NAMES = [
  'planner',
  'executor',
  'critic',
  'debugger',
] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLE_NAMES)[number];

export interface UsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
}

export interface PortProbe {
  readonly available: boolean;
  readonly supportsReconcile: boolean;
  readonly supportsUsage: boolean;
  readonly supportsCancel: boolean;
}

export interface SessionPort {
  probe(): Promise<PortProbe>;
  reconcile(operationId: string): Promise<'found' | 'missing' | 'uncertain'>;
  usage(operationId: string): Promise<UsageReport | 'unavailable'>;
  cancel(operationId: string): Promise<'cancelled' | 'pending' | 'unsupported'>;
}

export interface NativeToolPort {
  probe(): Promise<PortProbe>;
  reconcile(operationId: string): Promise<'found' | 'missing' | 'uncertain'>;
  usage(operationId: string): Promise<UsageReport | 'unavailable'>;
  cancel(operationId: string): Promise<'cancelled' | 'pending' | 'unsupported'>;
}
