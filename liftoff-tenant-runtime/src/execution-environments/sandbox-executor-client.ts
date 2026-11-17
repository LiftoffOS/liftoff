import { log } from '../infrastructure/logging';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { mintRuntimeOidc } from '../infrastructure/oidc';
import type {
  SandboxExecutorInterface,
  SandboxSession,
  SandboxToolCallInput,
  SandboxToolCallResult,
} from './sandbox-executor';

/**
 * HTTP client used by tool-gateway-service (split mode) to dispatch tool
 * calls against the dedicated sandbox-executor Cloud Run service. Mirrors
 * the SandboxExecutorInterface so the tool-gateway singleton accepts the
 * same shape whether the orchestrator runs in-process (monolith) or behind
 * /v2/execute (split).
 */
export class SandboxExecutorClient implements SandboxExecutorInterface {
  constructor(private readonly url: string) {
    if (!url) {
      throw new Error('SandboxExecutorClient requires SANDBOX_EXECUTOR_URL');
    }
  }

  async execute(session: SandboxSession, toolCall: SandboxToolCallInput): Promise<SandboxToolCallResult> {
    const oidc = await mintRuntimeOidc(this.url);
    if (!oidc) {
      return { success: false, data: {}, error: 'sandbox_executor_oidc_unavailable' };
    }
    try {
      const res = await fetch(`${this.url}/v2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oidc}` },
        body: JSON.stringify({ session, toolCall }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await readBoundedErrorText(res);
        return {
          success: false,
          data: {},
          error: `sandbox_executor_transport_${res.status}: ${text.slice(0, 200)}`,
        };
      }
      return (await res.json()) as SandboxToolCallResult;
    } catch (err) {
      log.warn({ message: 'sandbox-executor client failed', error: (err as Error).message });
      return { success: false, data: {}, error: `sandbox_executor_error: ${(err as Error).message}` };
    }
  }
}
