// Platform Backend callbacks for the universal peer-collaboration tools —
// find_teammates / send_agent_message / read_agent_messages.
//
// These three are registered TWO ways and must behave identically in both:
//   1. Interactive loop — mcp-server registers them as MCP tools (createToolGatewayMcpServer).
//   2. Structured workflow — a `tool_call` step naming one is dispatched from the
//      `__builtin:` branch of AgentExecutionService (agent-execution/service.ts).
// They are callbacks to Platform Backend, never gateway connectors. The fetch
// shape and the taint predicate live here so the two dispatch paths cannot
// drift: a divergence on the `originTrust` stamp or on the taint detection would
// be a silent trust hole, exactly what the workflow path would reintroduce if it
// hand-rolled its own copy.
//
// Trust DECISIONS stay at the call sites, because only they hold the run's
// TrustRef: `send` passes `originTrust` = the run's current trust; `read`'s
// caller inspects `messagesCarryUntrustedOrigin(result.data)` and upgrades its
// own cell. This module does the transport and the detection, never the mutation.

import { logger } from '../infrastructure/logging';
import { getManagedSecret } from '../infrastructure/secret-store';

/** Env both call sites read from `process.env`; null when unset (dev without a
 *  platform-callback wiring), which the callers surface as an unavailable tool. */
export interface CollabCallbackEnv {
  platformBackendUrl: string;
  platformCallbackToken: string;
}

export interface CollabCallResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  /** Present only when ok === false. */
  error?: string;
}

const CALLBACK_TIMEOUT_MS = 10_000;

/** Reads the callback env, or null if either half is missing. Kept here so both
 *  the MCP registration guard and the workflow-step arm apply the same rule. */
export function readCollabCallbackEnv(): CollabCallbackEnv | null {
  const platformBackendUrl = process.env.PLATFORM_BACKEND_URL;
  const platformCallbackToken = getManagedSecret('PLATFORM_CALLBACK_TOKEN');
  if (!platformBackendUrl || !platformCallbackToken) return null;
  return { platformBackendUrl, platformCallbackToken };
}

function authHeaders(token: string): Record<string, string> {
  return { 'X-Service-Auth': token, 'Content-Type': 'application/json' };
}

async function runCallback(
  toolName: string,
  tenantId: string,
  fetchFn: () => Promise<Response>,
): Promise<CollabCallResult> {
  try {
    const response = await fetchFn();
    if (!response.ok) {
      logger.warn({ status: response.status, tenantId }, `${toolName} callback failed`);
      return { ok: false, status: response.status, data: null, error: `Platform returned ${response.status}` };
    }
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, tenantId }, `${toolName} callback error`);
    return { ok: false, status: null, data: null, error: message };
  }
}

/** GET /find-teammates — pure discovery read, no trust implications. */
export async function callFindTeammates(
  env: CollabCallbackEnv,
  args: { tenantId: string; agentId: string; query: string },
): Promise<CollabCallResult> {
  const url =
    `${env.platformBackendUrl}/api/internal/platform-tools/find-teammates`
    + `?tenantId=${encodeURIComponent(args.tenantId)}`
    + `&agentId=${encodeURIComponent(args.agentId)}`
    + `&query=${encodeURIComponent(args.query)}`;
  return runCallback('find_teammates', args.tenantId, () =>
    fetch(url, {
      method: 'GET',
      headers: authHeaders(env.platformCallbackToken),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    }),
  );
}

/** POST /send-agent-message. `senderAgentId` is the RUNNING agent, never a param;
 *  `originTrust` is the sending run's live trust, stamped so the recipient's run
 *  upgrades when it reads this. The caller supplies both from runtime context. */
export async function callSendAgentMessage(
  env: CollabCallbackEnv,
  args: {
    tenantId: string;
    senderAgentId: string;
    recipientAgentId: string;
    content: string;
    metadata?: Record<string, unknown>;
    originTrust: 'trusted' | 'untrusted_inbound';
  },
): Promise<CollabCallResult> {
  const url = `${env.platformBackendUrl}/api/internal/platform-tools/send-agent-message`;
  return runCallback('send_agent_message', args.tenantId, () =>
    fetch(url, {
      method: 'POST',
      headers: authHeaders(env.platformCallbackToken),
      body: JSON.stringify({
        tenantId: args.tenantId,
        senderAgentId: args.senderAgentId,
        recipientAgentId: args.recipientAgentId,
        content: args.content,
        metadata: args.metadata ?? {},
        originTrust: args.originTrust,
      }),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    }),
  );
}

/** GET /agent-messages. A read, but ALSO the taint producer: the caller must
 *  inspect messagesCarryUntrustedOrigin(result.data) and, if true, upgrade its
 *  run to 'untrusted_inbound'. This module never mutates trust itself. */
export async function callReadAgentMessages(
  env: CollabCallbackEnv,
  args: { tenantId: string; agentId: string; limit?: number },
): Promise<CollabCallResult> {
  const url =
    `${env.platformBackendUrl}/api/internal/platform-tools/agent-messages`
    + `?agentId=${encodeURIComponent(args.agentId)}`
    + `&tenantId=${encodeURIComponent(args.tenantId)}`
    + `&limit=${args.limit ?? 20}`;
  return runCallback('read_agent_messages', args.tenantId, () =>
    fetch(url, {
      method: 'GET',
      headers: authHeaders(env.platformCallbackToken),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    }),
  );
}

/** True if a read_agent_messages response carries any message whose sending run
 *  was untrusted_inbound — the taint signal that upgrades the reading run. The
 *  single source of this predicate for both the MCP handler and the workflow arm. */
export function messagesCarryUntrustedOrigin(data: unknown): boolean {
  const msgs = (data as { messages?: Array<{ originTrust?: string; origin_trust?: string }> } | null)?.messages;
  if (!Array.isArray(msgs)) return false;
  return msgs.some((m) => (m?.originTrust ?? m?.origin_trust) === 'untrusted_inbound');
}
