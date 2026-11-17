// Platform Callback Client
// Posts skill feedback to platform-backend for the skills flywheel.
//
// Fire-and-forget callers: agent-execution, reflection-engine, hitl-enforcement.
// All callers wrap this in .catch() — a callback failure must never abort the
// calling flow.

import { ServiceClient } from '@liftoffos/service-client';
import { withManagedServiceAuth } from '../infrastructure/service-client-auth';
import { logger } from '../infrastructure/logging';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { getManagedSecret } from '../infrastructure/secret-store';

export interface SkillFeedbackPayload {
  tenantId: string;
  /** Runtime-space agents.id — kept on the wire unchanged (ADR-039 §3). */
  agentId: string;
  /** Control-plane internal_agents.id. Callers never set this: it is resolved
   *  inside postSkillFeedback so every present and future caller is correct. */
  internalAgentId?: string;
  taskId?: string;
  feedback: Array<{
    skillId: string;
    skillName: string;
    outcome: 'success' | 'failure' | 'hitl_approved' | 'hitl_rejected';
    refinedInstruction?: string;
    refinedDescription?: string;
    newPitfallSkill?: { name: string; description: string; instruction: string; tags?: string[] };
  }>;
}

let client: ServiceClient | null = null;

export function getPlatformCallbackClient(): ServiceClient | null {
  if (!process.env.PLATFORM_BACKEND_URL || !getManagedSecret('PLATFORM_CALLBACK_TOKEN')) return null;
  if (!client) {
    client = new ServiceClient(withManagedServiceAuth('PLATFORM_CALLBACK_TOKEN', {
      resolveTargetUrl: async () => process.env.PLATFORM_BACKEND_URL!,
      onLog: (level, ctx, msg) => logger[level as 'info' | 'warn' | 'error' | 'debug']?.({ ...ctx }, msg),
    }));
  }
  return client;
}

export async function postSkillFeedback(payload: SkillFeedbackPayload): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return;

  // INV-TR-010: anything published to the control plane carries the INTERNAL
  // agent id alongside the runtime id. Every caller of this chokepoint passes
  // the runtime agents.id, which matches zero internal_agents rows on the
  // platform — so the id is resolved here, once, for all present and future
  // callers. A mapping miss or lookup failure sends without the field rather
  // than aborting (the platform's legacy fallback translates bare agentIds);
  // resolveInternalAgentId already logs agent_id_reverse_mapping_miss.
  let internalAgentId: string | null = null;
  try {
    internalAgentId = await resolveInternalAgentId(payload.tenantId, payload.agentId, 'skill-feedback');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: payload.tenantId, agentId: payload.agentId },
      'Non-fatal: internal-agent-id lookup failed for skill-feedback — sending without it',
    );
  }

  // No explicit Content-Type — ServiceClient.buildHeaders defaults to
  // application/json. Passing it here as 'Content-Type' (Capitalized) would
  // coexist with the lowercase 'content-type' default after `new Headers()`
  // normalisation, causing node's fetch to emit a comma-joined header value
  // ("application/json, application/json") that express.json refuses to
  // parse — leaving req.body empty and every required zod field failing
  // validation.
  const resp = await c.fetch('platform', '/api/internal/platform-tools/skill-feedback', {
    method: 'POST',
    body: JSON.stringify({ ...payload, ...(internalAgentId ? { internalAgentId } : {}) }),
    breakerKey: 'platform:skill-feedback',
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
}

// WS-3.6 — typed wrappers used by notifications-send-handler.ts and
// escalation-helper.ts. Each is a thin RPC over the existing platform-callback
// transport (OIDC + circuit-breaker). All callers wrap them in try/catch — a
// callback failure must never abort the calling flow.

export interface EnqueueNotificationViaCallbackInput {
  accountIds: string[];
  tenantId: string;
  type: 'task_update' | 'team_activity' | 'escalation';
  payload: {
    internalAgentName?: string;
    eventTitle?: string;
    eventSummary?: string;
    eventLink?: string;
    actionRequired?: boolean;
    priority?: 'normal' | 'urgent';
    agentId?: string;
    invocationId?: string;
    [k: string]: unknown;
  };
}

export async function enqueueNotificationViaCallback(
  input: EnqueueNotificationViaCallbackInput,
): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return; // No PB URL configured — no-op (parity with postSkillFeedback)
  // No explicit Content-Type — see comment on postSkillFeedback (WS-C).
  const resp = await c.fetch('platform', '/api/internal/notifications/enqueue', {
    method: 'POST',
    body: JSON.stringify(input),
    breakerKey: 'platform:notifications-enqueue',
  });
  if (!resp.ok) throw new Error(`enqueueNotificationViaCallback HTTP ${resp.status}`);
}

export async function resolveAccountsByRole(
  tenantId: string,
  role: string,
): Promise<string[]> {
  const c = getPlatformCallbackClient();
  if (!c) return [];
  const resp = await c.fetch(
    'platform',
    `/api/internal/tenants/${encodeURIComponent(tenantId)}/members/by-role/${encodeURIComponent(role)}`,
    { method: 'GET', breakerKey: 'platform:members-by-role' },
  );
  if (!resp.ok) throw new Error(`resolveAccountsByRole HTTP ${resp.status}`);
  const body = (await resp.json()) as { account_ids: string[] };
  return body.account_ids;
}

export async function resolveAgentOwnerAccount(
  tenantId: string,
  agentId: string,
): Promise<string | null> {
  const c = getPlatformCallbackClient();
  if (!c) return null;
  const resp = await c.fetch(
    'platform',
    `/api/internal/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(agentId)}/owner`,
    { method: 'GET', breakerKey: 'platform:agent-owner' },
  );
  if (!resp.ok) throw new Error(`resolveAgentOwnerAccount HTTP ${resp.status}`);
  const body = (await resp.json()) as { account_id: string | null };
  return body.account_id;
}

export async function resolveDefaultEscalationRecipients(
  tenantId: string,
  agentId: string,
): Promise<string[]> {
  const c = getPlatformCallbackClient();
  if (!c) return ['role:admin']; // safe-by-default when callback unconfigured
  const resp = await c.fetch(
    'platform',
    `/api/internal/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(agentId)}/escalation-recipients`,
    { method: 'GET', breakerKey: 'platform:escalation-recipients' },
  );
  if (!resp.ok) throw new Error(`resolveDefaultEscalationRecipients HTTP ${resp.status}`);
  const body = (await resp.json()) as { recipients: string[] };
  return body.recipients;
}

export interface EnqueueEscalationNotificationInput {
  tenantId: string;
  /** RUNTIME-space agent id (ExecutionContext.agentId). Kept for rollout
   *  compatibility and diagnostics; PB must not use it to query
   *  internal_agents — a runtime id matches zero rows there with no error,
   *  silently discarding the configured recipient. */
  agentId: string;
  /** CONTROL-PLANE internal_agents.id, resolved through
   *  internal_agent_runtime_mapping via resolveInternalAgentId (INV-TR-010).
   *  Null when no mapping row exists (agent mid-provisioning) — PB then falls
   *  back loudly instead of silently. Per ADR-039, this named field — not a
   *  bare `agentId` — is how an agent crosses the TR→PB boundary. */
  internalAgentId: string | null;
  invocationId: string | null;
  escalationId: string;
  reason: string;
  threadId: string | null;
  /** Which kind of record this announces, which is all PB needs to word it.
   *
   *  'escalation'   — the run ended and a person is being told (the original
   *                   WS-3.9 case). The default when absent, so an older caller
   *                   keeps the wording it always had.
   *  'blocker'      — the run is parked until somebody acts outside the product.
   *  'clarification'— the run is parked until somebody answers a question.
   *
   *  Announcing a parked run as "escalated" describes something that already
   *  ended, and tells the reader the wrong thing about what happens next. */
  recordKind?: 'escalation' | 'blocker' | 'clarification';
  /** The chat thread this escalation was written into, when one was opened.
   *
   *  PB-space, unlike `threadId` above, which for an autonomous run is a
   *  runtime-local id that addresses nothing over there. This is the one the
   *  Slack DM and the Teams card can actually link to, so passing it is what
   *  turns "here is a wall of text" into "here is where to go". */
  chatThreadId?: string | null;
}

export async function enqueueEscalationNotification(
  input: EnqueueEscalationNotificationInput,
): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return;
  // No explicit Content-Type — see comment on postSkillFeedback (WS-C).
  const resp = await c.fetch('platform', '/api/internal/notifications/escalation', {
    method: 'POST',
    body: JSON.stringify(input),
    breakerKey: 'platform:notifications-escalation',
  });
  if (!resp.ok) throw new Error(`enqueueEscalationNotification HTTP ${resp.status}`);
}

export interface OpenEscalationThreadInput {
  tenantId: string;
  /** CONTROL-PLANE internal_agents.id (ADR-039). PB attaches the message to
   *  this team; a runtime id addresses nothing there. */
  internalAgentId: string;
  escalationId: string;
  reason: string;
  /** The run's thread. PB decides by lookup whether it is one of its own — a
   *  chat-origin run's is, an autonomous run's is not — and appends or opens a
   *  new thread accordingly. Passing it is not a claim that it is a PB id. */
  threadId?: string | null;
  title?: string | null;
  /** What the thread is FOR. 'escalation' (default) means the run stopped and
   *  somebody must act; 'delivery' means the work finished and here it is.
   *
   *  Same mechanism, different label, and the label matters: escalation counts
   *  are read as runs that got stuck, and a delivered checklist is not one. */
  kind?: 'escalation' | 'delivery';
}

/** Open (or extend) the chat thread that carries an escalation.
 *
 *  An escalated run has ended, so it is deliberately not in the /review queue,
 *  which holds only work that resumes when someone answers it. That left the
 *  Slack DM as the only delivery and no screen to check if it was missed. This
 *  puts the blocker in the team's chat, where a person already looks.
 *
 *  Returns the PB thread id so the caller can hand it to the notification and
 *  give the DM somewhere to point. Null when the callback client is
 *  unconfigured or PB could not resolve one. */
export async function openEscalationThread(
  input: OpenEscalationThreadInput,
): Promise<string | null> {
  const c = getPlatformCallbackClient();
  if (!c) return null;
  const resp = await c.fetch('platform', '/api/internal/agent-chat/escalation-thread', {
    method: 'POST',
    body: JSON.stringify(input),
    breakerKey: 'platform:escalation-thread',
  });
  if (!resp.ok) throw new Error(`openEscalationThread HTTP ${resp.status}`);
  const body = await resp.json().catch(() => null) as { threadId?: string | null } | null;
  return body?.threadId ?? null;
}

export interface RegisterRoutineProposalInput {
  tenantId: string;
  /** Runtime-space agents.id. Resolved to the control-plane id in here, the
   *  same chokepoint rule postSkillFeedback follows (INV-TR-010), so no
   *  caller can send a wrong-space id that matches zero platform rows. */
  agentId: string;
  /** Control-plane internal_agents.id (ADR-039). Callers never set this: it
   *  is resolved inside registerRoutineProposal so every present and future
   *  caller is correct. Honoured when supplied, for a caller that already
   *  resolved it. */
  internalAgentId?: string;
  /** The platform chat thread the ask happened in. */
  threadId: string;
  /** The schedule and the work in one sentence, in the person's terms.
   *  Required for start and change; a stop composes its own prose. */
  routineProse?: string;
  /** What the proposal does. Absent means start. */
  action?: 'start' | 'change' | 'stop';
  /** For change and stop: the existing routine as the person named it. */
  target?: string;
}

/** A single shape rather than a discriminated union: this repo compiles with
 *  strictNullChecks off, so a union would not narrow and every reader would
 *  fight the compiler. */
export interface RegisterRoutineProposalOutcome {
  registered: boolean;
  /** The platform applied the change without a confirmation question: the
   *  person's own words stated it exactly (statedChangeAgrees on the
   *  platform side), so the ask itself was the consent. The model reports
   *  it as done and reversible instead of asking. */
  autoAccepted?: boolean;
  /** Set when registered is false. The platform's own vocabulary
   *  ('open_proposal_exists', 'already_offered', 'ambiguous_target',
   *  'not_recorded'), plus two of this side's: 'unavailable' when the callback
   *  client is unconfigured or this agent has no control-plane mapping, and
   *  'not_registerable' when the platform answered 404 — the thread is not one
   *  of its conversations this team member sits in, or the team member is not
   *  active. Either way nothing was registered, and the tool must say so
   *  rather than let the model imply a schedule exists. */
  reason?: string;
  /** For 'ambiguous_target': the routines the target could have meant, for
   *  the model to relay so the person can name one. */
  candidates?: string[];
}

export interface RegisterColleagueRequestInput {
  tenantId: string;
  /** Runtime-space agents.id, resolved to the control-plane id in here. */
  agentId: string;
  internalAgentId?: string;
  /** The platform chat thread the ask happened in; absent for an unattended run. */
  threadId?: string;
  colleague: 'caio' | 'insights' | 'liftoff';
  /** The change or the question, in the person's terms. */
  request: string;
  /** What a change touches, as the team understood it (wording only). */
  area?: string;
}

export type RegisterColleagueRequestOutcome =
  /** Registered: the colleague's words will be posted into the chat. */
  | { registered: boolean; reason?: string }
  /** Answered inline, for a team with no chat. */
  | { answered: true; reply: string }
  | { answered: false; reason: string };

/** Bring one of the platform assistants in, from the bring_in_colleague tool.
 *  Same id resolution and the same 404 rule as registerRoutineProposal. In a
 *  chat the platform only registers the ask (the colleague's words arrive
 *  out of turn), so the call is as quick as a routine proposal's. From an
 *  unattended run the colleague answers inside this call, which takes as
 *  long as one of their turns; that wait is bounded by an abort signal
 *  rather than `timeoutMs`, which this client (built without a CallPolicy)
 *  does not apply. */
export async function registerColleagueRequest(
  input: RegisterColleagueRequestInput,
): Promise<RegisterColleagueRequestOutcome> {
  const c = getPlatformCallbackClient();
  if (!c) return { registered: false, reason: 'unavailable' };

  let internalAgentId: string | null = input.internalAgentId ?? null;
  if (!internalAgentId) {
    try {
      internalAgentId = await resolveInternalAgentId(input.tenantId, input.agentId, 'bring-in-colleague');
    } catch (err) {
      logger.warn({ err, tenantId: input.tenantId, agentId: input.agentId }, 'bring_in_colleague: internal agent id resolution failed');
    }
  }
  if (!internalAgentId) return { registered: false, reason: 'unavailable' };

  const resp = await c.fetch('platform', '/api/internal/agent-chat/colleague-request', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: input.tenantId,
      internalAgentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      colleague: input.colleague,
      request: input.request,
      ...(input.area ? { area: input.area } : {}),
    }),
    breakerKey: 'platform:colleague-request',
    ...(input.threadId ? {} : { signal: AbortSignal.timeout(COLLEAGUE_INLINE_TIMEOUT_MS) }),
  });
  if (resp.status === 404) return { registered: false, reason: 'not_registerable' };
  if (!resp.ok) throw new Error(`registerColleagueRequest HTTP ${resp.status}`);
  const body = await resp.json().catch(() => null) as
    | { registered?: boolean; reason?: string; answered?: boolean; reply?: string }
    | null;
  if (body?.answered === true && typeof body.reply === 'string') return { answered: true, reply: body.reply };
  if (body?.answered === false) return { answered: false, reason: body.reason ?? 'no_reply' };
  if (body?.registered === true) return { registered: true };
  return { registered: false, reason: body?.reason ?? 'not_recorded' };
}

/** An inline answer waits for one colleague turn: a data question answers in
 *  well under a minute, a wider one with a few tool calls in two or three.
 *  Past that the ask is reported as unavailable rather than guessed. */
const COLLEAGUE_INLINE_TIMEOUT_MS = 180_000;

/** Register a routine proposal from the propose_routine tool.
 *
 *  Unlike postSkillFeedback, a mapping miss does not send without the id: the
 *  platform route REQUIRES the control-plane id (it validates the team is
 *  active), so an unresolved agent is answered as unavailable instead.
 *  Non-2xx from the platform throws, like openEscalationThread — the tool
 *  handler turns it into an honest failure for the model. */
export async function registerRoutineProposal(
  input: RegisterRoutineProposalInput,
): Promise<RegisterRoutineProposalOutcome> {
  const c = getPlatformCallbackClient();
  if (!c) return { registered: false, reason: 'unavailable' };

  let internalAgentId: string | null = input.internalAgentId ?? null;
  if (!internalAgentId) {
    try {
      internalAgentId = await resolveInternalAgentId(input.tenantId, input.agentId, 'propose-routine');
    } catch (err) {
      logger.warn(
        { err, tenantId: input.tenantId, agentId: input.agentId },
        'propose_routine: internal agent id resolution failed',
      );
    }
  }
  if (!internalAgentId) return { registered: false, reason: 'unavailable' };

  const resp = await c.fetch('platform', '/api/internal/agent-chat/routine-proposal', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: input.tenantId,
      internalAgentId,
      threadId: input.threadId,
      ...(input.routineProse ? { routineProse: input.routineProse } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.target ? { target: input.target } : {}),
    }),
    breakerKey: 'platform:routine-proposal',
  });
  // 404 is the platform saying "not from here": the thread is not one of its
  // conversations this team member sits in (a runtime-minted thread id, say),
  // or the team member is not active. That is a REFUSAL with a sentence of its
  // own, not a transport failure — throwing would make the tool say the
  // platform was unreachable when it answered perfectly clearly.
  if (resp.status === 404) return { registered: false, reason: 'not_registerable' };
  if (!resp.ok) throw new Error(`registerRoutineProposal HTTP ${resp.status}`);
  const body = await resp.json().catch(() => null) as
    | { registered?: boolean; autoAccepted?: boolean; reason?: string; candidates?: string[] }
    | null;
  if (body?.registered === true) {
    return { registered: true, ...(body.autoAccepted === true ? { autoAccepted: true } : {}) };
  }
  return {
    registered: false,
    reason: body?.reason ?? 'not_recorded',
    ...(Array.isArray(body?.candidates) ? { candidates: body.candidates } : {}),
  };
}

export interface SettleMcpChatRunInput {
  tenantId: string;
  approvalId: string;
  /** RUNTIME-space id of the gated agent, on the expiry (`outcome:'failed'`)
   *  path. Kept for rollout compatibility; PB must not use it against
   *  internal_agents. Optional; omitted on the resume path. */
  agentId?: string;
  /** CONTROL-PLANE internal_agents.id for the same agent (INV-TR-010 /
   *  ADR-039). PB's Teams card grey-out resolves the agent's display name from
   *  internal_agents, which the runtime-space id cannot address. */
  internalAgentId?: string | null;
  outcome: 'completed' | 'failed';
  /** The chat thread the paused turn belongs to. PB posts the continuation here
   *  for EVERY chat origin (web / Slack / Teams / MCP), so the reply is visible
   *  even when there's no durable MCP run. Omit for non-chat (autonomous /
   *  workflow) resumes — PB's chat-thread guard then skips the post. */
  threadId?: string;
  /** outcome:'completed' — the resumed continuation to post as the assistant
   *  message (may be empty; a matching run still completes so it can never hang). */
  replyText?: string;
  /** outcome:'failed' — the error_code stamped on the run (e.g.
   *  'approval_expired' when the 24h timer fires with no operator decision). */
  errorCode?: string;
  /** outcome:'completed' — runtime agent ids of the teammates the resumed run
   *  handed work to, unique and in the order they were brought in, from the
   *  durable record of the delegations that ran, so the continuation the
   *  control plane posts is attributed the way a finished turn's reply is. */
  delegatedTo?: string[];
}

/** Durable MCP HITL (Option 1): settle the mcp_chat_runs row that paused on this
 *  approval.
 *   - 'completed' → PB posts the continuation as the assistant message and flips
 *     the run to 'completed', so the client's liftoff_chat_result poll returns
 *     the real reply on the SAME run.
 *   - 'failed'    → PB flips the run to 'failed' (e.g. the 24h expiry fired with
 *     no decision), freeing the thread so the client isn't stuck polling
 *     waiting_on_human and a new turn is no longer blocked by the active-per-
 *     thread index.
 *  Best-effort: PB no-ops when no MCP run matches this approvalId (web / Slack /
 *  Teams-origin approvals), and callers wrap this in a catch — a callback failure
 *  must never abort the resume / expiry flow. */
export async function settleMcpChatRunViaCallback(input: SettleMcpChatRunInput): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return;
  // No explicit Content-Type — see comment on postSkillFeedback (WS-C).
  const resp = await c.fetch('platform', '/api/internal/mcp-chat-runs/settle-by-approval', {
    method: 'POST',
    body: JSON.stringify(input),
    breakerKey: 'platform:mcp-chat-run-settle',
  });
  if (!resp.ok) throw new Error(`settleMcpChatRunViaCallback HTTP ${resp.status}`);
}

/** Self-wake settlement: deliver a resumed wake's continuation to its chat surface. PB
 *  derives the channel from the thread and inserts an assistant message (web/mcp) or active-posts
 *  (slack/teams). Best-effort; the caller keeps the wake in settlement_pending on failure so a
 *  settlement retry re-drives delivery (never reruns the agent). */
export async function settleWakeViaCallback(input: {
  tenantId: string; wakeId: string; threadId?: string | null; agentId?: string | null;
  channel?: 'web' | 'slack' | 'teams' | 'mcp' | null; replyText: string;
  /** Runtime agent ids of the teammates the delivered run handed work to, so
   *  the assistant message the control plane inserts carries the same
   *  contributors a streamed reply would. */
  delegatedTo?: string[];
}): Promise<{ delivered: boolean }> {
  const c = getPlatformCallbackClient();
  if (!c) return { delivered: false };
  const resp = await c.fetch('platform', '/api/internal/wake-settlement', {
    method: 'POST',
    body: JSON.stringify(input),
    breakerKey: 'platform:wake-settlement',
  });
  if (!resp.ok) throw new Error(`settleWakeViaCallback HTTP ${resp.status}`);
  try { return (await resp.json()) as { delivered: boolean }; } catch { return { delivered: true }; }
}

/** At-least-once persistence for a completed chat turn's assistant reply. The
 *  primary persistence path is PB consuming the chat-turn SSE stream; this
 *  callback is the disconnect-proof backstop — PB upserts the message keyed by
 *  turnId and no-ops when the stream consumer already stored it. Bounded
 *  retries; failure is non-fatal (the SSE path is primary). */
export async function settleChatTurnViaCallback(input: {
  tenantId: string; threadId: string; agentId: string; turnId: string;
  replyText: string; inputTokens?: number; outputTokens?: number;
  /** Marks the settled row as narration about the run rather than as the team
   *  speaking. Only `run_progress` is accepted by the control plane; anything
   *  else is refused there rather than trusted from here. */
  messageType?: 'run_progress';
  /** This run's own id, for the control plane's attachment-claim log lines to
   *  cite the run a settled reply came from. */
  invocationId?: string;
  /** True for the turn's FINAL reply, the one the success branch settles.
   *  Absent for the partial a paused turn settles: that text stops mid-work,
   *  often on the very tool that will produce a file card, and the card then
   *  lands under the continuation — so the control plane holds only a final
   *  reply to its attachment claims. */
  final?: boolean;
  /** Runtime agent ids of the teammates this turn handed work to, unique and
   *  in the order they were brought in, from the durable record of the
   *  delegations that ran. The control plane resolves them to display names
   *  and persists them as the reply's contributors, so a person who closed
   *  the tab sees the same chips as one who watched the hand-over live. */
  delegatedTo?: string[];
}): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await c.fetch('platform', '/api/internal/agent-chat/settle-turn', {
        method: 'POST',
        body: JSON.stringify(input),
        breakerKey: 'platform:chat-settle-turn',
      });
      if (resp.ok) return;
      lastErr = new Error(`settleChatTurnViaCallback HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Tell the control plane that one of the three assistants' browser tasks has
 * finished, so it wakes that conversation and delivers.
 *
 * A task finishing is an event, and the assistants' threads live in the
 * control plane's database: this service can watch the task but cannot wake
 * the conversation. Without this the person was told to send a message so the
 * work could be picked up, and a file they never came back for was never
 * delivered.
 *
 * The agents' half of this needs no callback — their threads are here.
 */
export async function announceBrowserTaskToAssistant(input: {
  tenantId: string;
  threadId: string;
  /** 'liftoff' | 'insights' | 'team_plan' — which assistant's conversation. */
  assistant: string;
  brief: string;
  senderAccountId?: string;
}): Promise<void> {
  const c = getPlatformCallbackClient();
  if (!c) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await c.fetch('platform', '/api/internal/browser-tasks/finished', {
        method: 'POST',
        body: JSON.stringify(input),
        breakerKey: 'platform:browser-task-finished',
      });
      if (resp.ok) return;
      lastErr = new Error(`announceBrowserTaskToAssistant HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Canonical thread info. PB owns canonical chat messages, so it is the source of
 *  both the revision cursor (TR stores it on the wake row at pause; reconciles at resume to gate native
 *  session-resume) AND the origin channel (stored as origin_surface for the operator surface). Returns
 *  null when unavailable (callback not configured / PB error) — the caller MUST then cold-start on
 *  resume (fail safe) and leave origin_surface null. */
export async function getWakeThreadInfo(
  tenantId: string, threadId: string,
): Promise<{ revision: number; channel: 'web' | 'slack' | 'teams' | 'mcp' | null } | null> {
  const c = getPlatformCallbackClient();
  if (!c) return null;
  try {
    const resp = await c.fetch(
      'platform',
      `/api/internal/wake-settlement/thread-revision?tenantId=${encodeURIComponent(tenantId)}&threadId=${encodeURIComponent(threadId)}`,
      { method: 'GET', breakerKey: 'platform:wake-thread-revision' },
    );
    if (!resp.ok) return null;
    const j = (await resp.json()) as { revision?: number; channel?: 'web' | 'slack' | 'teams' | 'mcp' | null };
    if (typeof j.revision !== 'number') return null;
    return { revision: j.revision, channel: j.channel ?? null };
  } catch {
    return null;
  }
}

/** Revision-only convenience for the resume-time staleness reconcile. */
export async function getWakeThreadRevision(tenantId: string, threadId: string): Promise<number | null> {
  const info = await getWakeThreadInfo(tenantId, threadId);
  return info ? info.revision : null;
}

/** Fetch one skill bundle file's content from the control plane.
 *
 *  The control plane verifies the digest before answering, and the caller
 *  verifies nothing again — it is the same check, and doing it twice over the
 *  same bytes proves nothing extra. Null means the file is unavailable, which
 *  the materializer reports rather than papering over. */
export async function fetchSkillBundleFile(
  tenantId: string,
  storageRef: string,
  sha256: string,
): Promise<string | null> {
  const c = getPlatformCallbackClient();
  if (!c) return null;

  const query = new URLSearchParams({ tenantId, storageRef, sha256 });
  const resp = await c.fetch('platform', `/api/internal/skill-bundle-file?${query.toString()}`, {
    method: 'GET',
    breakerKey: 'platform:skill-bundle-file',
  });

  if (!resp.ok) return null;
  const body = (await resp.json()) as { content?: unknown };
  return typeof body.content === 'string' ? body.content : null;
}
