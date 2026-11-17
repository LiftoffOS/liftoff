import type { SandboxProviderV2 } from '../types';

export interface DispatchInput {
  toolName: string;
  input: Record<string, unknown>;
  sandboxId: string;
  tenantId: string;
  agentId: string;
  invocationId: string;
}

export interface DispatchResult {
  success: boolean;
  data?: Record<string, unknown> | unknown;
  error?: string;
}

export interface DispatchCtx {
  provider: SandboxProviderV2;
}

export interface Dispatcher {
  supports(toolName: string): boolean;
  handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult>;
}
