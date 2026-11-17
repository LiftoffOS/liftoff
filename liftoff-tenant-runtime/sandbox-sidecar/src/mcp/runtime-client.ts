import { runtimeAuthHeaders } from '../auth/runtime-auth';
import { config } from '../config';
import { logger } from '../shared/logger';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ExecuteResult {
  success: boolean;
  data?: unknown;
  error?: string;
  hitl_pending?: boolean;
  idempotency_key?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RuntimeMcpClient {
  private cachedTools: McpToolDef[] | null = null;

  constructor(
    private readonly runtimeBaseUrl: string = config.runtimeBaseUrl,
  ) {}

  async listTools(): Promise<{ tools: McpToolDef[] }> {
    if (this.cachedTools) return { tools: this.cachedTools };
    const res = await fetch(`${this.runtimeBaseUrl}/internal/sandbox/mcp/tools`, {
      headers: await runtimeAuthHeaders(['mcp:list']),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`runtime returned ${res.status}`);
    }
    const body = (await res.json()) as { tools: McpToolDef[] };
    this.cachedTools = body.tools;
    return body;
  }

  async dispatch(toolName: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<ExecuteResult> {
    const maxAttempts = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${this.runtimeBaseUrl}/internal/sandbox/mcp/dispatch`, {
          method: 'POST',
          headers: { ...(await runtimeAuthHeaders(['mcp:dispatch'])), 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_name: toolName, args, idempotency_key: idempotencyKey }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401) throw new Error('jwt_rejected');
        if (res.status >= 500) throw new Error(`runtime_5xx: ${res.status}`);
        return (await res.json()) as ExecuteResult;
      } catch (err) {
        lastErr = err as Error;
        if (lastErr.message === 'jwt_rejected') break;
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000));
      }
    }
    logger.error({ msg: 'mcp dispatch failed', toolName, err: lastErr?.message });
    throw lastErr ?? new Error('mcp_dispatch_failed');
  }

  async awaitApproval(idempotencyKey: string, timeoutMs: number): Promise<ExecuteResult> {
    const res = await fetch(`${this.runtimeBaseUrl}/internal/sandbox/mcp/await-approval`, {
      method: 'POST',
      headers: { ...(await runtimeAuthHeaders(['mcp:await'])), 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey, timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    return (await res.json()) as ExecuteResult;
  }
}

export const runtimeMcpClient = new RuntimeMcpClient();
