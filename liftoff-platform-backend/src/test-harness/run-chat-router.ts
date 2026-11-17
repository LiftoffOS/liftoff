// PB-side agent-test-harness endpoint.
//
// POST /api/internal/test-harness/run-chat
//
// Drives ONE scenario through the same chat-service code path real
// users hit (PB → runAgentChatTurn → TR /api/interactive-chat/...
// chat-turn over HTTP+SSE), captures every event with full args /
// result / usage detail, and returns the assembled
// AgentHarnessRunResult. End-to-end probe — complements the TR-direct
// run-agent endpoint (execution-layer probe) that ships in
// tenant-runtime.
//
// Auth: X-Service-Auth via TEST_HARNESS_SERVICE_TOKEN. Mounted BEFORE
// authMiddleware so internal callers can hit it without a Firebase
// session. The same token is shared with the TR-side
// /spawn-session / /teardown-session sidecar endpoints used here for
// browser-session preconditions.
//
// Detail parity with TR-direct: this endpoint requests traceMode=true
// on the chat-turn body. TR's chat-event-relay then emits richer SSE
// events (catalog / tool_call args / tool_call_finished / usage) which
// chat-service forwards onto runAgentChatTurn's output. The assembler
// here populates the FULL AgentHarnessRunResult shape — args, result,
// per-call error, exposed catalog, usage — so the report is identical
// in detail to the TR-direct surface. Real chat from the frontend never
// sets traceMode and never receives those events.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { LLM_MODEL_TIERS, normalizeTier } from '../llm/types';
import crypto from 'crypto';
import type {
  AgentHarnessRunResult,
  ToolCallTrace,
} from '@liftoffos/agent-test-scenarios';
import { runAgentChatTurn } from '../agent-chat/chat-service';
import * as chatRepo from '../agent-chat/chat-repository';
import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from '../connectors/tenant-runtime-url';
import { log } from '../infrastructure/logging';

const router = Router();

// ── Auth gate ─────────────────────────────────────────────────────────
// Reuse the standard PB pattern: timing-safe match against a registered
// internal service token. We piggyback on TENANT_RUNTIME_SERVICE_TOKEN
// (already known to both PB and TR + already provisioned in CI / Cloud
// Run env). A future dedicated TEST_HARNESS_SERVICE_TOKEN could replace
// it without changing this file's contract.
const ACCEPTED_TOKEN_ENV_VARS = [
  'TEST_HARNESS_SERVICE_TOKEN',
  'TENANT_RUNTIME_SERVICE_TOKEN',
] as const;

function serviceAuth(req: Request, res: Response, next: NextFunction): void {
  const presented = req.headers['x-service-auth'] as string | undefined;
  if (!presented) {
    res.status(401).json({ error: 'missing X-Service-Auth' });
    return;
  }
  for (const envVar of ACCEPTED_TOKEN_ENV_VARS) {
    const expected = process.env[envVar];
    if (!expected || expected.length === 0) continue;
    if (
      presented.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    ) {
      next();
      return;
    }
  }
  res.status(401).json({ error: 'invalid X-Service-Auth' });
}

router.use(serviceAuth);

// ── Request schema ────────────────────────────────────────────────────

const SetupSchema = z
  .object({
    browserSession: z
      .object({
        initialUrl: z.string().url().optional(),
      })
      .optional(),
  })
  .optional();

const RunChatRequestSchema = z.object({
  tenantId: z.string().uuid(),
  /** Internal-agent UUID (the public-facing /dashboard/agents id). The
   *  endpoint resolves the runtime agent_id via TR's mapping table the
   *  same way runAgentChatTurn does — no mapping work needed here. */
  agentId: z.string().uuid(),
  prompt: z.string().min(1).max(50000),
  /** Synthetic account used for the chat-thread participant + as the
   *  message-sender id for tool gating (mirrors what real chat sends as
   *  body.userId). Defaults to a per-call UUID. */
  userAccountId: z.string().uuid().optional(),
  /** Turn-level sender attribution (agent_chat_turns.sender_account_id).
   *  MUST be a REAL accounts.id — the column has an FK to accounts(id), so
   *  a synthetic UUID would fail the whole turn. Omit for guest-path runs
   *  (sender NULL, recall_conversations not registered). */
  senderAccountId: z.string().uuid().optional(),
  /** Bounds the SDK loop. The chat-service path doesn't accept this
   *  today; reserved for a future passthrough. */
  maxTurns: z.number().int().min(1).max(50).optional(),
  threadId: z.string().uuid().optional(),
  /**
   * Drive the run as an EVENT rather than a chat turn.
   *
   * Forwarded to the runtime's run-agent harness, which stamps the structured
   * trigger. This endpoint's own path — runAgentChatTurn — is a chat turn by
   * construction, and a chat turn is the wrong entry point for any role that
   * wakes on a trigger: a code reviewer asked in chat reads a pull request and
   * reports back, while the same agent woken by pr.opened reads it and
   * publishes a review.
   */
  trigger: z.object({
    source: z.string().min(1).max(100),
    entityType: z.string().min(1).max(100),
    payload: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  /**
   * Run THIS invocation on another provider than the agent is configured
   * for — the runtime's own service-auth-only override, forwarded as is. It
   * is what lets one hire be exercised on every vendor family, and so on
   * every engine, without editing the hire; the same recording taken four
   * ways is the evidence a default engine is promoted on.
   *
   * Triggered runs only: a chat turn goes through runAgentChatTurn, which
   * carries no override, and dropping the field there would record the
   * agent's own provider under another provider's name.
   */
  modelConfigOverride: z.object({
    modelId: z.string().max(500).optional(),
    provider: z.string().max(50).optional(),
    tier: z.preprocess(normalizeTier, z.enum(LLM_MODEL_TIERS).optional()),
  }).optional(),
  setup: SetupSchema,
});

interface SetupResult {
  steps: string[];
}

// ── Endpoint ──────────────────────────────────────────────────────────

router.post('/run-chat', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const parseResult = RunChatRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ ok: false, error: 'invalid_request', details: parseResult.error.format() });
    return;
  }
  const { tenantId, agentId, prompt, trigger, modelConfigOverride } = parseResult.data;
  if (modelConfigOverride && !trigger) {
    res.status(400).json({
      ok: false,
      error: 'invalid_request',
      details: 'modelConfigOverride applies to triggered runs only; a chat turn runs on the agent\'s configured provider',
    });
    return;
  }
  const userAccountId = parseResult.data.userAccountId ?? crypto.randomUUID();
  const requestedThreadId = parseResult.data.threadId;
  const invocationId = crypto.randomUUID();
  const setupResult: SetupResult = { steps: [] };

  let createdThreadId: string | null = null;

  try {
    // 1. Synthetic thread row in PB's chat tables so chat-service can
    //    persist the user message via chatRepo.appendMessage. Real chat
    //    creates these via the public chat router; the harness uses the
    //    repo directly. We pass channel='web' to match the runAgentChatTurn
    //    default; participants get added inside chat-service.
    // accountId MUST be null — synthetic harness UUIDs don't correspond to
    // real `accounts` rows and agent_chat_threads.account_id has an FK to
    // accounts(id). The chat-service path doesn't require a real account
    // (it just persists messages and forwards to TR); userId can be a
    // synthetic UUID since it's used as a sender flag for tool gating,
    // not as a real-account reference.
    const thread = await chatRepo.createThread(
      tenantId,
      null,
      'web',
      null,
      'test-harness ephemeral',
    );
    createdThreadId = requestedThreadId ?? thread.id;
    // If the caller pinned a threadId we still want a row to exist; but
    // for simplicity we use the row we just created and surface its id.
    void requestedThreadId; // reserved for future "reuse this thread" semantics

    // 2. Optional pre-condition: spawn an Anchor browser session for
    //    the synthetic thread so hasActiveBrowserSession-gated tools
    //    appear in the catalog. PB has no Anchor credentials; we call
    //    TR's sidecar endpoint over the same authenticated HTTP path
    //    runChatTurnStream uses.
    if (parseResult.data.setup?.browserSession) {
      try {
        const baseUrl = await resolveRuntimeBaseUrl(tenantId);
        const headers = await buildRuntimeHeaders(tenantId);
        const spawnBody = {
          tenantId,
          agentId,
          threadId: createdThreadId,
          ownerAccountId: userAccountId,
          ...(parseResult.data.setup.browserSession.initialUrl
            ? { initialUrl: parseResult.data.setup.browserSession.initialUrl }
            : {}),
          idleTimeoutMinutes: 10,
          // When Anchor's real API is unavailable (e.g. 402 because the
          // account is out of credit), TR's spawn-session inserts a
          // synthetic mock_anchor web_sessions row instead of failing
          // hard. The catalog gate then exposes the
          // hasActiveBrowserSession-gated tools and the agent's
          // tool-selection assertions can still run; browser-tool
          // handlers detect the mock row and return synthetic
          // success. The harness's job is to probe the agent's tool
          // CHOICE, not the underlying vendor's availability.
          allowMockOnFailure: true,
        };
        const spawnRes = await fetch(`${baseUrl}/api/internal/test-harness/spawn-session`, {
          method: 'POST',
          headers,
          body: JSON.stringify(spawnBody),
        });
        const spawnJson = (await spawnRes.json()) as { ok?: boolean; session?: { id?: string; mocked?: boolean; mockReason?: string }; error?: string; message?: string };
        if (!spawnRes.ok || !spawnJson.ok) {
          // Surface the underlying vendor message (e.g. "Anchor 402:" for
          // out-of-credit) FIRST, falling back to the generic error code
          // ("spawn_failed") only when there's no useful message. The
          // earlier order swallowed actionable signals like billing
          // exhaustion behind a generic label.
          const reason = spawnJson.message
            ? `${spawnJson.error ?? 'spawn_failed'}:${spawnJson.message}`
            : (spawnJson.error ?? `http_${spawnRes.status}`);
          setupResult.steps.push(`browserSession=failed:${reason}`);
        } else {
          const sessionLabel = spawnJson.session?.mocked
            ? `mocked:${spawnJson.session.id ?? '<unknown>'} (${spawnJson.session.mockReason ?? 'Anchor unavailable'})`
            : `spawned:${spawnJson.session?.id ?? '<unknown>'}`;
          setupResult.steps.push(`browserSession=${sessionLabel}`);
          if (parseResult.data.setup.browserSession.initialUrl && !spawnJson.session?.mocked) {
            setupResult.steps.push(`browserSession=navigatedTo:${parseResult.data.setup.browserSession.initialUrl}`);
          }
        }
      } catch (e) {
        setupResult.steps.push(`browserSession=failed:${(e as Error).message}`);
      }
    }

    // 3. Drive runAgentChatTurn with traceMode: true. The async iterable
    //    yields the FULL set of events (text_delta / tool_call /
    //    tool_call_finished / usage / catalog / complete / error). The
    //    accumulator below populates every field of the shared
    //    AgentHarnessRunResult shape — args, result, error, exposed
    //    catalog, usage — so PB-side parity with TR-direct is complete.
    // A triggered run is not a chat turn, so it does not go through
    // runAgentChatTurn at all. It is handed to the runtime's own harness, which
    // stamps the structured trigger the event dispatcher would have — the thing
    // that decides whether externally-authored content arrives trusted, and
    // whether a workflow step naming an operation can resolve a host.
    if (trigger) {
      const baseUrl = await resolveRuntimeBaseUrl(tenantId);
      const headers = await buildRuntimeHeaders(tenantId);
      const runRes = await fetch(`${baseUrl}/api/internal/test-harness/run-agent`, {
        method: 'POST',
        // buildRuntimeHeaders already sets Content-Type. Adding a lowercase
        // copy does not override it — fetch combines duplicate header names,
        // producing `application/json, application/json`, which express's JSON
        // parser does not match. The body then arrives empty and the runtime
        // rejects it for missing the fields that were in fact sent.
        headers,
        body: JSON.stringify({
          tenantId, agentId, prompt, trigger,
          ...(modelConfigOverride ? { modelConfigOverride } : {}),
          threadId: createdThreadId,
          // `setup` is the runtime's own pre-conditions object (a browser
          // session, optionally pre-navigated), not this endpoint's step log.
          // Omitted: a triggered case needs no pre-conditions, and sending the
          // wrong shape is rejected as invalid_request with an empty run,
          // which reads as "the agent did nothing" rather than as a bad call.
        }),
      });
      const body = await runRes.json() as AgentHarnessRunResult;
      if (!runRes.ok) {
        // Said loudly, because the quiet version is indistinguishable from the
        // finding: a rejected call returns no tool calls and no text, which
        // reads in a report as "the agent did nothing" — and cost a re-record
        // to tell apart from a real behavioural failure.
        log.error(
          { status: runRes.status, tenantId, agentId, body },
          'harness trigger run REJECTED — the recording below is not agent behaviour',
        );
      }
      return res.json({ ...body, setup: setupResult, durationMs: Date.now() - startedAt });
    }

    const toolCallById = new Map<string, ToolCallTrace>();
    const orderedCalls: ToolCallTrace[] = [];
    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let exposedToolNames: string[] = [];
    let terminalKind: 'complete' | 'error' | null = null;
    let terminalError: { code: string; message: string } | null = null;

    for await (const event of runAgentChatTurn({
      tenantId,
      agentId,
      threadId: createdThreadId,
      // The run is recorded under THIS id, so the trace fetched below and the
      // id handed back are the run that actually ran.
      invocationId,
      userId: userAccountId,
      userDisplayName: 'Test Harness',
      userRole: 'tester',
      content: prompt,
      channelHint: 'web',
      traceMode: true,
      ...(parseResult.data.senderAccountId
        ? { senderAccountId: parseResult.data.senderAccountId }
        : {}),
    })) {
      switch (event.type) {
        case 'thinking':
          break;
        case 'text_delta':
          finalText += event.text;
          break;
        case 'tool_call': {
          // Without callId we synthesize a stable per-event id so the
          // assembler can pair tool_call_finished events. Real
          // trace-mode events always carry a callId.
          const callId = event.callId ?? `synthetic-${orderedCalls.length}`;
          const trace: ToolCallTrace = {
            callId,
            toolName: event.tool,
            args: event.args,
          };
          toolCallById.set(callId, trace);
          orderedCalls.push(trace);
          break;
        }
        case 'tool_call_finished': {
          const trace = toolCallById.get(event.callId);
          if (trace) {
            trace.result = event.result;
            if (event.error) trace.error = event.error;
          }
          break;
        }
        case 'usage':
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          if (event.cachedTokens !== undefined) cachedTokens += event.cachedTokens;
          break;
        case 'catalog':
          exposedToolNames = event.exposedToolNames;
          break;
        case 'hitl_required':
          // No SSE-side action in the harness — surface it as a tool
          // call so the assertion can fail / pass based on the
          // approval id.
          break;
        case 'complete':
          terminalKind = 'complete';
          // Prefer the canonical persisted final text when present.
          if (event.message?.content) finalText = event.message.content;
          break;
        case 'error':
          terminalKind = 'error';
          terminalError = { code: event.code, message: event.message };
          break;
        default:
          break;
      }
    }

    // 4. Teardown the browser session if we spawned one. Best-effort —
    //    don't fail the run if teardown errors. TR also auto-closes via
    //    idle TTL; this just frees the slot earlier so a tight loop of
    //    setup-using scenarios doesn't trip Anchor's concurrent-session
    //    rate limit.
    if (parseResult.data.setup?.browserSession) {
      try {
        const baseUrl = await resolveRuntimeBaseUrl(tenantId);
        const headers = await buildRuntimeHeaders(tenantId);
        await fetch(`${baseUrl}/api/internal/test-harness/teardown-session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tenantId, threadId: createdThreadId }),
        }).then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as { closed?: boolean; sessionId?: string };
          if (j.closed && j.sessionId) {
            setupResult.steps.push(`teardown=closedActiveSession:${j.sessionId}`);
          }
        });
      } catch (e) {
        setupResult.steps.push(`teardown=failed:${(e as Error).message}`);
      }
    } else {
      // Belt-and-braces: even when no scenario setup spawned a session,
      // the AGENT may have spawned one mid-turn (start_browser_session,
      // run_browser_task). Tear those down too — mirrors what TR's
      // run-agent endpoint already does for the execution-layer probe.
      try {
        const baseUrl = await resolveRuntimeBaseUrl(tenantId);
        const headers = await buildRuntimeHeaders(tenantId);
        await fetch(`${baseUrl}/api/internal/test-harness/teardown-session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tenantId, threadId: createdThreadId }),
        });
      } catch {
        // Non-fatal.
      }
    }

    // B.1 — pass-through audit_logs + pauseState from TR so end-to-end
    // scenarios can use expectsAuditLogContains / expectsHitlPause matchers
    // even though PB doesn't watch the audit ledger or the adapter pause
    // events directly. We fetch from TR's auxiliary /invocation-trace
    // endpoint which reads its own audit_logs + hitl_approval_requests
    // tables (the only authoritative view of both).
    let auditLogs: AgentHarnessRunResult['auditLogs'];
    let pauseState: AgentHarnessRunResult['pauseState'] = { kind: 'none' };
    try {
      const baseUrl = await resolveRuntimeBaseUrl(tenantId);
      const headers = await buildRuntimeHeaders(tenantId);
      const traceRes = await fetch(
        `${baseUrl}/api/internal/test-harness/invocation-trace?invocationId=${encodeURIComponent(invocationId)}`,
        { headers },
      );
      if (traceRes.ok) {
        const body = (await traceRes.json()) as {
          auditLogs?: AgentHarnessRunResult['auditLogs'];
          pauseState?: AgentHarnessRunResult['pauseState'];
        };
        auditLogs = body.auditLogs ?? [];
        if (body.pauseState) pauseState = body.pauseState;
      } else {
        log.warn(
          { tenantId, invocationId, status: traceRes.status },
          'PB harness: invocation-trace lookup failed; auditLogs/pauseState empty',
        );
        auditLogs = [];
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, tenantId, invocationId },
        'PB harness: invocation-trace fetch threw; auditLogs/pauseState empty',
      );
      auditLogs = [];
    }

    const response: AgentHarnessRunResult = {
      ok: terminalKind === 'complete',
      invocationId,
      threadId: createdThreadId,
      finalText,
      toolCalls: orderedCalls,
      inputTokens,
      outputTokens,
      cachedTokens,
      outcome: terminalKind === 'complete' ? 'success' : terminalKind === 'error' ? 'error' : null,
      ...(terminalError ? { outcomeReason: `${terminalError.code}: ${terminalError.message}` } : {}),
      exposedToolNames,
      durationMs: Date.now() - startedAt,
      setup: setupResult,
      auditLogs,
      pauseState,
    };
    res.json(response);
  } catch (err) {
    log.error(
      { err: (err as Error).message, stack: (err as Error).stack, tenantId, agentId, invocationId, threadId: createdThreadId },
      'test-harness: run-chat failed',
    );
    // Return a FULL AgentHarnessRunResult shape — empty arrays for the
    // collection fields — so the CLI runner's table formatter doesn't
    // crash on .map() / .length. The `ok: false` + error fields drive
    // the assertion's FAIL branch with the underlying error message.
    const failureResponse: AgentHarnessRunResult = {
      ok: false,
      error: 'harness_failed',
      message: (err as Error).message,
      invocationId,
      threadId: createdThreadId ?? '',
      finalText: '',
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      outcome: 'error',
      outcomeReason: (err as Error).message,
      exposedToolNames: [],
      durationMs: Date.now() - startedAt,
      setup: setupResult,
    };
    res.status(500).json(failureResponse);
  }
});

export { router as testHarnessRouter };
