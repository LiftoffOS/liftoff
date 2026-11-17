// Active synthetic driver — fire a run on a real agent on a tenant WE OWN, then
// hand back a RunRef the adapters reconstruct. REUSES the shipped harness for
// user-created agents (TR run-agent); adds CAIO / Insights (simulated-user
// chat) and HRBP (throwaway-plan approval) drivers.
//
// Request shapes are matched to the REAL routes:
//   - TR run-agent:        POST {trHarnessUrl}            body {tenantId, agentId, prompt}      → {invocationId}
//   - CAIO chat-stream:    POST {wf}/team-plan/chat-stream  headers x-tenant-id/x-account-id/x-tenant-role, body {threadId, content}
//   - Insights chat-stream:POST {pb}/api/insights/chat-stream body {tenantId, threadId, content} (firebase-auth; bearer)
//   - HRBP plan create:    POST {wf}/workforce-plans         headers auth, body {title, agents, orgChart}  → {plan:{id}}
//   - HRBP plan approve:   POST {wf}/workforce-plans/:id/approve headers auth → {plan}; runId looked up from
//                          hrbp_provisioning_runs by plan_id (approve does NOT return it).
//
// Side-effect safety: own tenants + blast-radius caps + fake data. HRBP mutates
// a THROWAWAY plan only.

import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { logger as log } from '../../infrastructure/logging';
import { runStructuredJudge } from '../analyze/judge/llm-judge';
import { getCrossServicePool } from '../adapters/cross-db';
import type { AgentKind, RunRef } from '../reconstruct/trace-model';

interface Endpoints {
  trHarnessUrl?: string;
  workforceBaseUrl?: string;
  insightsBaseUrl?: string;
  serviceToken?: string;
  accountId?: string;
  role: string;
}

function endpoints(): Endpoints {
  return {
    trHarnessUrl: process.env.DIAGNOSTICS_TR_HARNESS_URL,
    workforceBaseUrl: process.env.DIAGNOSTICS_WORKFORCE_BASE_URL,
    insightsBaseUrl: process.env.DIAGNOSTICS_INSIGHTS_BASE_URL,
    serviceToken: process.env.DIAGNOSTICS_SERVICE_TOKEN,
    accountId: process.env.DIAGNOSTICS_ACCOUNT_ID,
    role: process.env.DIAGNOSTICS_CALLER_ROLE ?? 'owner',
  };
}

/** True when the driver for `kind` has the config it needs to run. The driver
 *  returns `{ skipped: true }` (not a failure) when unconfigured so an
 *  under-provisioned environment never false-fails the gate. */
export function driverConfigured(kind: AgentKind, ep = endpoints()): boolean {
  switch (kind) {
    case 'user-created':
      return Boolean(ep.trHarnessUrl);
    case 'caio':
    case 'hrbp':
      return Boolean(ep.workforceBaseUrl && ep.accountId);
    case 'insights':
      return Boolean(ep.insightsBaseUrl);
  }
}

function jsonHeaders(ep: Endpoints): Record<string, string> {
  return { 'content-type': 'application/json', ...(ep.serviceToken ? { authorization: `Bearer ${ep.serviceToken}` } : {}) };
}

// OIDC ingress for agent-service (run.invoker enforced at the platform layer;
// the diagnostics job SA is granted invoker on the eval-tenant agent-service).
// Same pattern as the passive harvest call in scripts/agent-diagnostics.ts.
const oidcAuth = new GoogleAuth();
const oidcClientCache = new Map<string, IdTokenClient>();
async function trIngressHeaders(serviceUrl: string): Promise<Record<string, string>> {
  const audience = new URL(serviceUrl).origin;
  let client = oidcClientCache.get(audience);
  if (!client) {
    client = await oidcAuth.getIdTokenClient(audience);
    oidcClientCache.set(audience, client);
  }
  const headers = await client.getRequestHeaders();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** workforce-service authenticates internal callers via x-tenant-id /
 *  x-account-id / x-tenant-role headers (see router caller-context). */
function workforceHeaders(ep: Endpoints, tenantId: string): Record<string, string> {
  return {
    ...jsonHeaders(ep),
    'x-tenant-id': tenantId,
    'x-account-id': ep.accountId ?? '',
    'x-tenant-role': ep.role,
  };
}

export interface ActiveScenario {
  agentKind: AgentKind;
  tenantId: string;
  agentId: string;
  objective: string;
  persona?: string;
  maxTurns?: number;
}

export type DriveOutcome = { ref: RunRef } | { skipped: true; reason: string } | { failed: true; reason: string };

/** Drive one synthetic run. Distinguishes skipped (unconfigured — non-gating)
 *  from failed (ran but errored — gating). */
export async function driveScenario(s: ActiveScenario): Promise<DriveOutcome> {
  const ep = endpoints();
  if (!driverConfigured(s.agentKind, ep)) {
    return { skipped: true, reason: `driver for ${s.agentKind} not configured` };
  }
  switch (s.agentKind) {
    case 'user-created':
      return driveUserCreated(s, ep);
    case 'caio':
      return driveCaio(s, ep);
    case 'insights':
      return driveInsights(s, ep);
    case 'hrbp':
      return driveHrbp(s, ep);
  }
}

// ---------------------------------------------------------------------------
// User-created — REUSE the shipped harness run-agent.
// ---------------------------------------------------------------------------
async function driveUserCreated(s: ActiveScenario, ep: Endpoints): Promise<DriveOutcome> {
  try {
    // The test-harness router (requireServiceAuth, no opts) verifies ONLY the
    // X-Service-Auth shared secret, and agent-service ingress requires OIDC
    // run.invoker — a Bearer token alone 401s. Mirror the passive harvest call.
    const ingress = await trIngressHeaders(ep.trHarnessUrl!);
    const res = await fetch(ep.trHarnessUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...ingress,
        ...(ep.serviceToken ? { 'X-Service-Auth': ep.serviceToken } : {}),
      },
      body: JSON.stringify({ tenantId: s.tenantId, agentId: s.agentId, prompt: s.objective }),
    });
    if (!res.ok) return { failed: true, reason: `run-agent ${res.status}` };
    const body = (await res.json()) as { invocationId?: string };
    if (!body.invocationId) return { failed: true, reason: 'run-agent returned no invocationId' };
    return { ref: { agentKind: 'user-created', tenantId: s.tenantId, agentId: s.agentId, key: body.invocationId } };
  } catch (err) {
    return { failed: true, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// CAIO — workforce-service /team-plan/chat-stream (header auth, {threadId, content}).
// ---------------------------------------------------------------------------
async function driveCaio(s: ActiveScenario, ep: Endpoints): Promise<DriveOutcome> {
  return driveChat(s, ep, {
    url: `${ep.workforceBaseUrl}/team-plan/chat-stream`,
    headers: () => workforceHeaders(ep, s.tenantId),
    body: (threadId, content) => ({ threadId, content }),
  });
}

// ---------------------------------------------------------------------------
// Insights — platform-backend /api/insights/chat-stream ({tenantId, threadId, content}).
// ---------------------------------------------------------------------------
async function driveInsights(s: ActiveScenario, ep: Endpoints): Promise<DriveOutcome> {
  return driveChat(s, ep, {
    url: `${ep.insightsBaseUrl}/api/insights/chat-stream`,
    headers: () => jsonHeaders(ep),
    body: (threadId, content) => ({ tenantId: s.tenantId, threadId, content }),
  });
}

interface ChatTransport {
  url: string;
  headers: () => Record<string, string>;
  body: (threadId: string | undefined, content: string) => Record<string, unknown>;
}

async function driveChat(s: ActiveScenario, ep: Endpoints, t: ChatTransport): Promise<DriveOutcome> {
  const kind = s.agentKind as 'caio' | 'insights';
  const maxTurns = s.maxTurns ?? 3;
  let threadId: string | undefined;
  let userMessage = s.objective;
  let lastAssistant = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    try {
      const res = await fetch(t.url, { method: 'POST', headers: t.headers(), body: JSON.stringify(t.body(threadId, userMessage)) });
      if (!res.ok || !res.body) {
        if (threadId) return { ref: { agentKind: kind, tenantId: s.tenantId, agentId: s.agentId, key: threadId } };
        return { failed: true, reason: `chat-stream ${res.status}` };
      }
      const { text, threadId: tid } = await consumeSse(res.body);
      threadId = tid ?? threadId;
      lastAssistant = text;
    } catch (err) {
      if (threadId) break;
      return { failed: true, reason: (err as Error).message };
    }
    const next = await nextSimulatedUserTurn(s, lastAssistant);
    if (!next || next.done) break;
    userMessage = next.message;
  }

  return threadId
    ? { ref: { agentKind: kind, tenantId: s.tenantId, agentId: s.agentId, key: threadId } }
    : { failed: true, reason: 'chat-stream yielded no thread id' };
}

/** Minimal SSE consumer: concatenates `data:` text deltas and extracts a thread
 *  id from any event that carries one. Tolerant of provider-specific framing. */
async function consumeSse(body: ReadableStream<Uint8Array>): Promise<{ text: string; threadId?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let threadId: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^data:\s?(.*)$/.exec(line.trim());
      if (!m) continue;
      try {
        const evt = JSON.parse(m[1]) as { type?: string; text?: string; delta?: string; threadId?: string; thread_id?: string };
        threadId = evt.threadId ?? evt.thread_id ?? threadId;
        if (typeof evt.text === 'string') text += evt.text;
        else if (typeof evt.delta === 'string') text += evt.delta;
      } catch {
        if (m[1] && m[1] !== '[DONE]') text += m[1];
      }
    }
  }
  return { text, threadId };
}

async function nextSimulatedUserTurn(s: ActiveScenario, lastAssistant: string): Promise<{ message: string; done: boolean } | null> {
  const system = `You are role-playing a USER talking to an AI assistant. Persona: ${s.persona ?? 'a workforce operator'}.
Your goal: ${s.objective}. Given the assistant's last reply, produce your next message, or set done=true if your
goal is satisfied or the assistant cannot help. Respond ONLY as JSON: {"message": "<your next message>", "done": <bool>}.`;
  return runStructuredJudge<{ message: string; done: boolean }>({
    system,
    user: `Assistant's last reply:\n${lastAssistant.slice(0, 2000)}`,
    tenantId: s.tenantId,
    purpose: 'diagnostics_simulated_user',
    maxTokens: 256,
  });
}

// ---------------------------------------------------------------------------
// HRBP — create + APPROVE a throwaway plan; the approve triggers the Cloud Tasks
// fan-out. The approve response returns {plan}, NOT the run id, so look up the
// run row by plan_id (hrbp_provisioning_runs is opened inside approve).
// ---------------------------------------------------------------------------
async function driveHrbp(s: ActiveScenario, ep: Endpoints): Promise<DriveOutcome> {
  try {
    const createRes = await fetch(`${ep.workforceBaseUrl}/workforce-plans`, {
      method: 'POST',
      headers: workforceHeaders(ep, s.tenantId),
      body: JSON.stringify({
        title: '[diagnostics] throwaway HRBP canary plan',
        // Blast-radius capped: a single synthetic agent spec.
        agents: [{ role: 'diagnostics-probe', roleSummary: 'synthetic canary probe', responsibilities: 'no-op', synthetic: true }],
        orgChart: { nodes: [], edges: [] },
      }),
    });
    if (!createRes.ok) return { failed: true, reason: `plan create ${createRes.status}` };
    const created = (await createRes.json()) as { plan?: { id?: string } };
    const planId = created.plan?.id;
    if (!planId) return { failed: true, reason: 'plan create returned no id' };

    const approveRes = await fetch(`${ep.workforceBaseUrl}/workforce-plans/${planId}/approve`, {
      method: 'POST',
      headers: workforceHeaders(ep, s.tenantId),
      body: JSON.stringify({}),
    });
    if (!approveRes.ok) return { failed: true, reason: `plan approve ${approveRes.status}` };

    // Look up the provisioning run opened by approve.
    const runId = await lookupHrbpRunId(s.tenantId, planId);
    if (!runId) return { failed: true, reason: 'no hrbp_provisioning_runs row for approved plan' };
    return { ref: { agentKind: 'hrbp', tenantId: s.tenantId, agentId: s.agentId, key: runId } };
  } catch (err) {
    return { failed: true, reason: (err as Error).message };
  }
}

async function lookupHrbpRunId(tenantId: string, planId: string): Promise<string | null> {
  const wf = getCrossServicePool('workforce');
  if (!wf) return null;
  // Brief poll — approve enqueues asynchronously; the run row is created
  // synchronously inside approve, so one read usually suffices.
  for (let i = 0; i < 5; i++) {
    const res = await wf.query(
      `SELECT id FROM hrbp_provisioning_runs WHERE plan_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [planId, tenantId],
    );
    const id = (res.rows[0] as { id: string } | undefined)?.id;
    if (id) return id;
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn({ message: 'active: HRBP run row not found after approve', planId });
  return null;
}
