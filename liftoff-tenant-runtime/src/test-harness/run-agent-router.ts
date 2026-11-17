// Automated agent test harness.
//
// POST /api/internal/test-harness/run-agent
//
// Runs a chat turn through the SAME agent-execution path the
// interactive-chat handler uses — same prompt build, same tool catalog,
// same executeTask — but with an EPHEMERAL synthetic invocation
// instead of a real user-owned thread, and returns the captured event
// trace as JSON so a CI runner / smoke job can assert on what tools
// the agent actually called. The point is "exercise the agent in prod
// without sitting at the React UI" — every tool that fires fires for
// real, every connector call hits real downstream services, every
// browser session spins up a real Anchor pod. The only synthetic part
// is the trigger.
//
// Auth: requireServiceAuth (OIDC), same gate as the real chat-turn
// route. Tenant + agent are caller-specified — operators are expected
// to point this at a designated test tenant when running CI smokes,
// not at customer prod tenants.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { normalizeTier } from '../llm/types';
import { v4 as uuidv4 } from 'uuid';
import { requireServiceAuth } from '../security/service-auth';
import type { InvocationEvent } from '../agent-execution/adapter/types';
import { logger } from '../infrastructure/logging';
import { deriveAllowedConnectors } from '../interactive-chat/connector-utils';
import { warmGovernancePreflightFireAndForget } from '../interactive-chat/chat-turn-handler';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';
import { connectorEventTrigger } from '../agent-lifecycle/types';
import { buildEventMessageEnvelope } from '../scheduling/event-input-envelope';
import { getPoolForService } from '../infrastructure/database';
import { harvestTarget, harvestOne, harvestAllActiveAgents } from '../diagnostics/driver/passive';
import type { AgentKind } from '../diagnostics/reconstruct/trace-model';
import { hasSessionBrowserConnector, platformPaneBrowserOn } from '../browser-sessions/session-vendor-connectors';

const router = Router();
router.use(requireServiceAuth());

/** Pre-conditions the harness can establish before running the prompt.
 *  These exist because the chat tool catalog is gated on RUNTIME state
 *  (does this thread have an active browser session? did the agent
 *  download a file already?), so a scenario that wants to assert on
 *  `read_active_browser_session` needs an active session in the catalog
 *  at prompt time, otherwise the tool isn't exposed and the assertion
 *  is testing the wrong thing. */
const SetupSchema = z.object({
  /** Pre-spawn an Anchor browser session for the synthetic thread.
   *  Optionally pre-navigate it to `initialUrl` so the inspect tools
   *  (read_active_browser_session text mode, screenshot, save-as-PDF,
   *  intervention-check, session-stats) have a real page to read. */
  browserSession: z.object({
    initialUrl: z.string().url().optional(),
  }).optional(),
}).optional();

const TestHarnessRequestSchema = z.object({
  tenantId: z.string().uuid(),
  /** Internal-agent UUID (the public-facing id from /dashboard/agents URL),
   *  NOT the runtime agent_id; the harness maps it through
   *  internal_agent_runtime_mapping the same way the real chat-turn
   *  handler does. */
  agentId: z.string().uuid(),
  prompt: z.string().min(1).max(50000),
  /** Synthetic accounts let the harness exercise message-sender-gated
   *  tools (run_browser_task, start_browser_session, etc.) without
   *  needing a real user row. Defaults to a stable per-test UUID; pass
   *  an explicit value if the test needs to target a particular account
   *  (e.g. one that has an Anchor profile already). */
  userAccountId: z.string().uuid().optional(),
  /** Bounds the SDK loop so a runaway agent can't burn credits in CI.
   *  Defaults to 8 — enough for one tool + reflect, not enough for a
   *  full task. */
  maxTurns: z.number().int().min(1).max(50).optional(),
  /** Optional explicit thread id. Synthetic UUIDs by default. */
  threadId: z.string().uuid().optional(),
  /**
   * Drive this run as an EVENT rather than a person typing.
   *
   * The default is a chat turn, which is the wrong entry point for any role
   * that wakes on a trigger. A code reviewer asked in chat reads the pull
   * request and reports back; the same agent woken by `pr.opened` reads it and
   * publishes a review. Its evals asserted on the reply and never saw the
   * review, because the harness only ever drove the chat path.
   *
   * Two things change with the trigger stamped, and the event dispatcher's own
   * comment says why they matter: without it trustLevelFor(undefined) is
   * 'trusted', so externally-authored content — a pull request title is
   * written by whoever opened it — arrives trusted; and a workflow step naming
   * an operation rather than a host has no host to resolve against.
   */
  trigger: z.object({
    source: z.string().min(1).max(100),
    entityType: z.string().min(1).max(100),
    /** The event body, as the connector would have delivered it. */
    payload: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  /** Pre-conditions to establish before running the prompt. See SetupSchema. */
  setup: SetupSchema,
  /** SERVICE-AUTH-ONLY per-invocation skill-disclosure override, for the eval
   *  that measures what disclosure costs. The two modes have to run against the
   *  same deployment, the same agent and the same skills for the comparison to
   *  mean anything, and an env var read at request time cannot express that.
   *  Omitted by every other caller, which then gets the deployment's mode. */
  skillDisclosureMode: z.enum(['inline', 'disclosed']).optional(),
  /** D4 — SERVICE-AUTH-ONLY model override for the tuning gate: run this ONE invocation with the
   *  candidate tuned model instead of the agent's configured model. This router is
   *  requireServiceAuth + OIDC-gated and never product-reachable, so the override cannot leak
   *  into product paths. A full modelConfig object ({modelId, provider, tier?, maxTokens?, temperature?}). */
  modelConfigOverride: z.object({
    modelId: z.string().max(500).optional(),
    provider: z.string().max(50).optional(),
    tier: z.preprocess(normalizeTier, z.enum(['large', 'medium', 'small'])).optional(),
    maxTokens: z.number().int().min(1).max(200000).optional(),
    temperature: z.number().min(0).max(2).optional(),
  }).optional(),
});

interface ToolCallTrace {
  callId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

interface SetupResult {
  /** What setup steps actually ran. Each entry is "kind=outcome". */
  steps: string[];
}

/** audit row trace surfaced to harness scenario assertions. Allows
 *  scenarios to write `expectsAuditLogContains: [{action: 'memory_save'}]`
 *  and `expectsAuditLogInputArgsNotMatching: [{action: 'memory_save',
 *  mustNotMatch: /eyJhbGc/}]` against the same ledger production uses. */
interface AuditLogTrace {
  id: string;
  action: string;
  outcome: string;
  errorCode: string | null;
  /** Sanitized — sanitizeArgs is applied at insert time, so what we read here
   *  is what the audit ledger persisted (credential-keyed values redacted,
   *  PII patterns scrubbed). The scenario matcher operates on this view. */
  inputArgs: unknown;
}

/** pause state derived from the adapter's pause_requested event so
 *  scenarios can write `expectsHitlPause: {kind: 'hitl_approval'}` and the
 *  runner can assert "agent paused, didn't complete" without polling DB.
 *  Kept in sync with packages/agent-test-scenarios/src/types.ts PauseKind. */
interface PauseState {
  kind: 'none' | 'hitl_approval' | 'ask_user' | 'admin_pause' | 'circuit_breaker' | 'budget_exceeded';
  /** The reason string carried on the underlying adapter event, if any. */
  reason?: string;
}

interface RunAgentResponse {
  ok: boolean;
  invocationId: string;
  threadId: string;
  /** Final assistant text content (last assistant_message block joined). */
  finalText: string;
  toolCalls: ToolCallTrace[];
  /** Token usage summed across the adapter's `usage` events. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Adapter completion outcome — 'success' / 'error' / 'escalated'. */
  outcome: string | null;
  outcomeReason?: string;
  /** Tools the catalog actually exposed for this run — useful so the
   *  test runner can assert "yes, run_browser_task is in scope for
   *  this agent" before checking that the agent called it. */
  exposedToolNames: string[];
  /** Skill ids retrieval actually put in front of the model this run.
   *
   *  Without this a caller cannot tell "the model ignored the guidance" from
   *  "the guidance was never retrieved", and those are opposite findings: one is
   *  about the model, the other about the embedding. The skill-disclosure eval
   *  turns on exactly that distinction — a task whose skill did not surface
   *  measures retrieval, not disclosure, and must not be scored as either. */
  retrievedSkillIds: string[];
  durationMs: number;
  /** What setup ran before the prompt — so the CLI can show "pre-spawned
   *  browser session" / etc. in its output and so a failure tied to
   *  setup vs the agent itself is debuggable. */
  setup?: SetupResult;
  /** audit_logs rows written during this invocation. Limited to 50
   *  rows to bound response size. Standard tools + connector tools
   *  + search sub-dispatches all appear here. */
  auditLogs?: AuditLogTrace[];
  /** pause state derived from adapter events. `kind: 'none'` when
   *  the invocation completed without a pause. */
  pauseState?: PauseState;
}

/** Synthetic invocation row. agent-execution writes its own canonical
 *  row (via executeTask), but we precreate the thread + a minimal
 *  invocations marker so the various invariants downstream don't
 *  trip on missing FKs. */
async function ensureSyntheticThread(
  tenantId: string,
  threadId: string,
  runtimeAgentId: string,
): Promise<void> {
  const pool = getPoolForService('scheduled-execution');
  // invocations.thread_id has an FK to threads(id) (migration 015) —
  // the synthetic invocation that executeTask writes would 23503 here
  // without a real threads row. Use the runtime agent_id since
  // threads.agent_id references agents(id), not internal_agents(id).
  // initiated_by_type='system' tags this row as harness-spawned so it
  // can be cleaned up by a future sweeper.
  await pool.query(
    `INSERT INTO threads (id, tenant_id, agent_id, initiated_by_type, title, status)
     VALUES ($1, $2, $3, 'system', 'test-harness ephemeral', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [threadId, tenantId, runtimeAgentId],
  );
}

router.post('/run-agent', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const parseResult = TestHarnessRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ ok: false, error: 'invalid_request', details: parseResult.error.format() });
    return;
  }
  const { tenantId, agentId, prompt, trigger } = parseResult.data;
  const userAccountId = parseResult.data.userAccountId ?? uuidv4();
  const threadId = parseResult.data.threadId ?? uuidv4();
  const invocationId = uuidv4();
  const maxTurns = parseResult.data.maxTurns ?? 8;

  try {
    // Resolve runtime agent id BEFORE the thread insert: threads.agent_id
    // → agents(id), and runtime agent_id is the right one. internal
    // agent id wouldn't satisfy the FK.
    const pool = getPoolForService('scheduled-execution');
    const internalAgentRow = await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM internal_agent_runtime_mapping
       WHERE internal_agent_id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );
    const runtimeAgentId = internalAgentRow.rows[0]?.agent_id ?? agentId;

    await ensureSyntheticThread(tenantId, threadId, runtimeAgentId);

    // Execute setup steps so the chat tool catalog is gated on the
    // RUNTIME state we need (active browser session, etc.) at the
    // moment we build it. Without this, scenarios that target
    // hasActiveBrowserSession-gated tools always see an empty catalog
    // for those tools and the assertions are testing the wrong thing.
    const setupResult: SetupResult = { steps: [] };
    if (parseResult.data.setup?.browserSession) {
      try {
        // The vendor the agent is actually equipped with, resolved the same way
        // the pane and the tools resolve it. A harness that names one vendor can
        // only test agents bound to that vendor, and it reports every other
        // agent's session as that vendor's outage rather than its own gap.
        const { createSessionForThread, gotoUrl } = await import('../browser-sessions/session-vendor-proxy');
        const created = await createSessionForThread({
          tenantId,
          agentId: runtimeAgentId,
          threadId,
          ownerAccountId: userAccountId,
          idleTimeoutMinutes: 10,
        });
        setupResult.steps.push(`browserSession=spawned:${created.vendor}:${created.id}`);
        const initialUrl = parseResult.data.setup.browserSession.initialUrl;
        if (initialUrl) {
          await gotoUrl(created.vendor, created.vendorSessionId, tenantId, initialUrl);
          setupResult.steps.push(`browserSession=navigatedTo:${initialUrl}`);
        }
      } catch (e) {
        setupResult.steps.push(`browserSession=failed:${(e as Error).message}`);
        // Surface the failure but continue — the test might still be
        // useful (e.g. an assertion that the agent gracefully handles
        // "no session available"), and burying the setup error would
        // make debugging harder.
      }
    }

    const instructionRow = await pool.query<{
      id: string;
      version: number;
      system_prompt: string | null;
      user_instructions: string | null;
      integrations: unknown;
      instructions_md: string | null;
      capability_tier: string | null;
      raw_input: unknown;
    }>(
      `SELECT id, version, system_prompt, user_instructions, integrations,
              instructions_md, capability_tier, raw_input
       FROM compiled_instructions
       WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [tenantId, runtimeAgentId],
    );
    if (instructionRow.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'no_active_instruction_for_agent', tenantId, agentId, runtimeAgentId });
      return;
    }
    const instruction = instructionRow.rows[0];
    const integrations = normalizeIntegrationsField(instruction.integrations);
    const allowedConnectors = deriveAllowedConnectors(integrations);

    // Governance preflight warm — the synthetic-invocation gap that made the harness
    // unable to exercise governed connector WRITES (create_merge_request etc.). The
    // real chat-turn handler warms the per-tenant preflight cache (admission status +
    // signed preflight token) on invocation start; the harness called executeTask
    // directly and skipped it, so the first Authorize RPC had no preflight and failed
    // closed. Warm it exactly as chat-turn does (internal agentId + bound connectors),
    // best-effort/non-awaited, before executeTask.
    warmGovernancePreflightFireAndForget(tenantId, agentId, allowedConnectors, 'standard', 'sandbox');

    // Build the chat tool catalog through the same engine path the
    // real handler uses, so the exposed-tools gating is identical.
    const { agentExecutionService } = await import('../agent-execution/service');
    // Provider + model resolved with the SAME chain the product paths use
    // (agent config > entitlements routing > 'anthropic') so the harness
    // catalog matches what a real run gets. The previous hardcoded
    // 'anthropic' pinned code_session's 'auto' routing to Claude Code even
    // on Workspace-AI-routed vendor workspaces — the harness was testing a
    // different tool surface than users hit (found in the dev E2E).
    const { getEntitlementsClient } = await import('../entitlements-client/service');
    const { resolveProviderFromConfig, resolveAgentModelId } = await import('../agent-execution/provider-resolution');
    const agentConfigRow = await pool.query<{ model_config: unknown }>(
      `SELECT model_config FROM agents WHERE id = $1 AND tenant_id = $2`,
      [runtimeAgentId, tenantId],
    );
    const rawModelConfig = agentConfigRow.rows[0]?.model_config;
    const agentModelConfig = (typeof rawModelConfig === 'string'
      ? JSON.parse(rawModelConfig)
      : rawModelConfig ?? {}) as { provider?: string; modelId?: string; tier?: string };
    // The tuning gate's override merges over the agent's config here exactly as
    // executeTask merges it, so the catalog and the engine describe one model.
    const harnessModelConfig = parseResult.data.modelConfigOverride
      ? { ...agentModelConfig, ...parseResult.data.modelConfigOverride }
      : agentModelConfig;
    const harnessTier = normalizeTier(harnessModelConfig.tier) as
      import('../entitlements-client/types').ModelTier | undefined;
    const harnessRouting = await getEntitlementsClient()
      .getModelForTask(tenantId, 'agent_execution', harnessTier)
      .catch(() => null);
    // The chat turn's resolution, call for call: a harness run that resolved
    // differently would test a tool surface users never get. The model rule in
    // particular (a workspace model applies only on the workspace's vendor) is
    // what keeps an overridden agent's code_session on its own vendor.
    const harnessProvider = resolveProviderFromConfig(harnessModelConfig, harnessRouting?.provider);
    const harnessModelId = resolveAgentModelId(harnessModelConfig, harnessProvider, harnessRouting);
    const { catalog, toolNames, activeBrowserSession } = await agentExecutionService.buildChatToolCatalog({
      tenantId,
      agentId: runtimeAgentId,
      instructionVersion: instruction.version,
      integrations,
      allowedActionTypes: ['*'],
      memoryScope: {},
      invocationId,
      threadId,
      resolvedProvider: harnessProvider,
      resolvedModelId: harnessModelId,
      explicitModelId: harnessModelConfig.modelId,
      messageSenderAccountId: userAccountId,
      // Decides whether read_skill is in the catalog. Passed the same value the
      // skill block below is rendered with, because a prompt that lists
      // guidance the model has no tool to fetch is worse than either mode.
      skillDisclosureMode: parseResult.data.skillDisclosureMode,
    });

    // Build the SAME system prompt the chat path builds. Without this the
    // harness routes through executeTask's distilled-prompt branch (which
    // uses instruction.systemPrompt directly), bypassing the Browser
    // session preamble + tool-selection guidance in system-prompt.ts —
    // and the agent then picks WebFetch on "navigate" because nothing
    // told it run_browser_task is the right tool. That made the harness
    // test a different prompt than real users hit, which defeats the
    // point. See chat-turn-handler.ts:880-907 for the canonical build.
    const { buildAgentChatSystemPrompt } = await import('../interactive-chat/system-prompt');
    const agentRoleRow = await pool.query<{ role: string | null; messaging_nickname: string | null }>(
      `SELECT role, messaging_nickname FROM agents WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [runtimeAgentId, tenantId],
    );
    const agentRole = agentRoleRow.rows[0]?.role ?? 'Agent';
    const agentNickname = agentRoleRow.rows[0]?.messaging_nickname ?? null;
    const systemPromptOverride = buildAgentChatSystemPrompt({
      agent: {
        role: agentRole,
        messagingNickname: agentNickname,
        systemPrompt: instruction.system_prompt,
        userInstructions: instruction.user_instructions,
      },
      user: { displayName: 'Test Harness', role: 'tester' },
      channel: 'web',
      hitlLevel: null,
      // The connector list / memory block aren't load-bearing for tool
      // selection — empty strings keep the prompt build self-contained
      // without dragging in connector-service / memory-service calls.
      connectorList: allowedConnectors.length > 0
        ? allowedConnectors.map((c) => `- ${c}`).join('\n')
        : 'No connectors configured.',
      memoryBlock: '',
      priorInvocationSummary: null,
      toolNames,
      activeBrowserSession: activeBrowserSession ? { id: activeBrowserSession.id } : null,
      // Mirrors the chat-turn-handler hasPaneBrowser check, BOTH halves of it.
      // This harness is what a browser change is verified through, so a gate
      // that answers differently here reports the feature broken when it is the
      // harness that is behind.
      hasBrowserConnector:
        (hasSessionBrowserConnector(allowedConnectors) || await platformPaneBrowserOn(tenantId))
        && !!userAccountId,
    });

    // The skill block, which the chat path appends right after this build and
    // this harness did not.
    //
    // That omission mattered more than it looks. buildSkillContextBlock prepends
    // BASELINE_SKILLS — identity and communication guardrails — so every
    // scenario run here was exercising an agent WITHOUT the guardrails every
    // real turn carries, in a file whose stated purpose is to run the same
    // prompt build users hit. Any scenario asserting on voice, refusal or
    // identity was asserting against a prompt no user has ever been given.
    //
    // Always rendered, never gated on the retrieval returning rows: gating would
    // strand the baselines for an agent whose skills are empty, which is exactly
    // the case where they carry the most weight. Same reasoning, same call, as
    // chat-turn-handler.
    const { retrieveContextSkills, buildSkillContextBlock, skillDisclosureMode } =
      await import('../skills/retrieval');
    const harnessSkills = await retrieveContextSkills(
      tenantId,
      runtimeAgentId,
      prompt,
      allowedConnectors.map((c) => `connector:${c}`),
      5,
      'chat',
    );
    const disclosureMode = skillDisclosureMode(parseResult.data.skillDisclosureMode);
    const systemPromptWithSkills =
      systemPromptOverride + '\n\n' + buildSkillContextBlock(harnessSkills, disclosureMode);

    // Capture every InvocationEvent the adapter emits into a trace.
    const toolCallById = new Map<string, ToolCallTrace>();
    const orderedCalls: ToolCallTrace[] = [];
    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let outcome: string | null = null;
    let outcomeReason: string | undefined;
    let observedPauseState: PauseState | undefined;

    const streamSink = (event: InvocationEvent): void => {
      switch (event.type) {
        case 'assistant_message': {
          const text = event.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (text) finalText = text;
          break;
        }
        case 'tool_call_started': {
          const trace: ToolCallTrace = {
            callId: event.callId,
            toolName: event.toolName,
            args: event.args,
          };
          toolCallById.set(event.callId, trace);
          orderedCalls.push(trace);
          break;
        }
        case 'tool_call_finished': {
          // LEDGER_OBSERVER_ONLY: collects a trace for the harness response.
          // The run itself goes through `executeTask`, which records there.
          const trace = toolCallById.get(event.callId);
          if (trace) {
            trace.result = event.result;
            if (event.error) trace.error = event.error;
          }
          break;
        }
        case 'usage':
          inputTokens += event.usage.inputTokens ?? 0;
          outputTokens += event.usage.outputTokens ?? 0;
          cachedTokens += event.usage.cachedTokens ?? 0;
          break;
        case 'completion':
          outcome = event.outcome;
          outcomeReason = event.reason;
          break;
        case 'pause_requested': {
          // capture pause for scenario assertion. Adapter PauseReason
          // ('ask_user' | 'hitl_gate' | 'admin') maps to the harness
          // PauseState.kind taxonomy the scenarios package consumes.
          const kindMap: Record<string, PauseState['kind']> = {
            hitl_gate: 'hitl_approval',
            ask_user: 'ask_user',
            admin: 'admin_pause',
          };
          observedPauseState = {
            kind: kindMap[event.reason] ?? 'none',
            reason: event.reason,
          };
          break;
        }
        default:
          break;
      }
    };

    const execResult = await agentExecutionService.executeTask({
      tenantId,
      agentId: runtimeAgentId,
      workflowId: uuidv4(),
      taskId: invocationId,
      objective: prompt,
      threadId,
      // Built through the same helper the event dispatcher uses, so the two
      // shapes cannot drift apart — which is exactly what happened once
      // before, when one event through two dispatchers produced two different
      // trust levels.
      ...(trigger
        ? {
          triggeredBy: 'event' as const,
          trigger: connectorEventTrigger(trigger.source, trigger.entityType),
          inputData: {
            eventSource: trigger.source,
            eventEntityType: trigger.entityType,
            // The normalized entity, built through the same helper the event
            // dispatcher uses. Without it a trigger-bound step resolves to a
            // tool and then has no event record to address — the run executes,
            // calls nothing, and reports success, which in a harness report is
            // indistinguishable from an agent that chose to do nothing.
            //
            // Spreading the raw payload at the top level, as this did first,
            // is not a substitute: `{{input.<field>}}` resolves against the
            // envelope, and the raw payload spells the same field two ways
            // depending on delivery path. See event-input-envelope.ts.
            message: buildEventMessageEnvelope(trigger.source, trigger.payload),
            eventData: trigger.payload,
          },
        }
        : {
          triggeredBy: 'human' as const,
          triggeredByUserId: userAccountId,
        }),
      invocationId,
      streamSink,
      prebuiltCatalog: catalog,
      systemPromptOverride: systemPromptWithSkills,
      // Synthetic invocation on a synthetic thread — don't serialize
      // with real prod chat for the same agent. Without this, hitting
      // the harness against a heavily-used agent gives a deluge of
      // 'agent_already_running' that has nothing to do with the
      // behavior under test.
      bypassAgentLock: true,
      // service-auth-only candidate-model override for the tuning gate (this invocation only).
      // zod validated the shape; narrow provider (string) to the execution ModelConfig union.
      modelConfigOverride: parseResult.data.modelConfigOverride as import('../agent-execution/types').ModelConfig | undefined,
    });

    // Tear down any browser sessions we spawned (setup OR agent-spawned
    // during the run). Without this each scenario leaves an Anchor
    // session alive for the 10-min idle TTL, and ~5 setup-using
    // scenarios in a row exhausts Anchor's account-level concurrent
    // session quota — every subsequent setup gets a 429 and the suite
    // produces SKIPs that look like agent/prompt regressions.
    try {
      const { closeSession: closeSessionRow, endTakeoverHoldForClose, getActiveForThread } = await import('../browser-sessions/repository');
      const { closeSession } = await import('../browser-sessions/session-vendor-proxy');
      // Close anything still attached to THIS thread (covers both setup-
      // spawned and agent-spawned sessions; the agent often calls
      // start_browser_session / run_browser_task during a scenario and
      // those leak too if we don't close them here).
      //
      // Through the vendor proxy, which dispatches on the row's OWN vendor.
      // This named Anchor outright, so a Browser Use or Browserbase session got
      // a DELETE against Anchor's API, 404'd into the swallowing catch, and was
      // marked closed locally while still running at its real vendor — holding
      // its upfront charge and one of the account's concurrency slots until its
      // own timeout. Stopping is also what SETTLES a session's cost, so those
      // scenarios billed us and recorded nothing. Which is exactly what the
      // first deployed verification of this feature found.
      const active = await getActiveForThread(tenantId, threadId);
      if (active?.vendorSessionId) {
        await endTakeoverHoldForClose(active.id).catch(() => {});
        await closeSession(active.vendor, active.vendorSessionId, tenantId).catch(() => {});
        await closeSessionRow(active.id, 'completed').catch(() => {});
        setupResult.steps.push(`teardown=closedActiveSession:${active.id}`);
      }
    } catch (e) {
      setupResult.steps.push(`teardown=failed:${(e as Error).message}`);
    }

    // executeTask also exposes a final outcome — overlay it on the
    // adapter-event-derived state when the adapter didn't emit a
    // completion (rare; pause / abort paths).
    if (!outcome) {
      outcome = execResult.success ? 'success' : 'error';
      if (!execResult.success && execResult.error) outcomeReason = execResult.error;
    }

    // query audit_logs for this invocation so scenarios can assert on
    // what the ledger actually persisted (sanitized input_args + outcome +
    // error_code). Capped at 50 rows to bound response size. Best-effort:
    // a failed query surfaces an empty array rather than failing the run
    // — the audit ledger isn't the thing under test for most scenarios.
    let auditLogs: AuditLogTrace[] | undefined;
    try {
      const pool = getPoolForService('scheduled-execution');
      const auditRes = await pool.query(
        `SELECT id, action, outcome, error_code, input_args
         FROM audit_logs
         WHERE invocation_id = $1
         ORDER BY created_at ASC
         LIMIT 50`,
        [invocationId],
      );
      auditLogs = auditRes.rows.map((r: { id: string; action: string; outcome: string; error_code: string | null; input_args: unknown }) => ({
        id: r.id,
        action: r.action,
        outcome: r.outcome,
        errorCode: r.error_code,
        inputArgs: r.input_args,
      }));
    } catch (err) {
      logger.warn({ err: (err as Error).message, invocationId }, 'test-harness: audit_logs query failed; surfacing empty array');
      auditLogs = [];
    }

    const response: RunAgentResponse = {
      ok: outcome === 'success',
      invocationId,
      threadId,
      finalText,
      toolCalls: orderedCalls,
      inputTokens,
      outputTokens,
      cachedTokens,
      outcome,
      ...(outcomeReason ? { outcomeReason } : {}),
      exposedToolNames: toolNames,
      retrievedSkillIds: harnessSkills.map((s) => s.id),
      durationMs: Date.now() - startedAt,
      setup: setupResult,
      auditLogs,
      pauseState: observedPauseState ?? { kind: 'none' },
    };
    res.json(response);
    void maxTurns; // reserved for a future maxTurns override; executeTask sources from execConfig today
  } catch (err) {
    logger.error(
      { err: (err as Error).message, stack: (err as Error).stack, tenantId, agentId, invocationId, threadId },
      'test-harness: run-agent failed',
    );
    res.status(500).json({
      ok: false,
      error: 'harness_failed',
      message: (err as Error).message,
      invocationId,
      threadId,
      durationMs: Date.now() - startedAt,
    });
  }
});

// ── Sidecar endpoints used by the PB-side test-harness runner ─────────
//
// PB's `/api/internal/test-harness/run-chat` endpoint goes through the
// real chat-service code path (PB → runAgentChatTurn → TR chat-turn over
// HTTP+SSE). It can't spawn an Anchor browser session itself — PB has
// no Anchor credentials. These sidecar endpoints let PB orchestrate the
// same scenario shape the TR-direct runner already supports:
//
//   1. POST /api/internal/test-harness/spawn-session   (before chat)
//   2. POST /api/internal/test-harness/run-chat        (PB side, drives chat)
//   3. POST /api/internal/test-harness/teardown-session (after chat)
//
// Both endpoints require a SYNTHETIC thread row to already exist for
// the given (tenantId, threadId) — the PB run-chat endpoint creates it
// before calling. We don't recreate the thread here.

const SpawnSessionRequestSchema = z.object({
  tenantId: z.string().uuid(),
  /** Internal-agent UUID (same field the run-agent endpoint accepts).
   *  Internally mapped to the runtime agent_id via
   *  internal_agent_runtime_mapping so the inserted web_sessions row
   *  ties to the same runtime agent the chat path will resolve. */
  agentId: z.string().uuid(),
  threadId: z.string().uuid(),
  /** Owner-account binding for the persisted Anchor profile. Match what
   *  the PB run-chat endpoint uses for the synthetic user. */
  ownerAccountId: z.string().uuid().optional(),
  /** Optional initial URL — pre-navigate the spawned session to this URL
   *  so the agent's first inspect (read/screenshot) has real content. */
  initialUrl: z.string().url().optional(),
  /** Idle timeout in minutes. Defaults to 10 (matches run-agent path). */
  idleTimeoutMinutes: z.number().int().min(1).max(60).optional(),
  /** When true, fall back to writing a SYNTHETIC web_sessions row tagged
   *  vendor='mock_anchor' if the real Anchor API call fails (e.g. HTTP
   *  402 when the account is out of credit). The catalog gate is
   *  database-driven (getActiveForThread checks the web_sessions row);
   *  a mock row exposes the hasActiveBrowserSession-gated tools so the
   *  agent's tool-selection assertions can still run. The browser-tool
   *  handlers detect mock sessions and return synthetic success without
   *  making the upstream Anchor call. Real chat NEVER sets this — only
   *  the test-harness path does. Defaults to false to preserve the
   *  existing real-session behavior. */
  allowMockOnFailure: z.boolean().optional(),
});

async function insertMockBrowserSessionRow(args: {
  tenantId: string;
  runtimeAgentId: string;
  threadId: string;
  ownerAccountId?: string;
}): Promise<{ id: string; vendorSessionId: string }> {
  // Mirrors the shape of a real vendor spawn's INSERT. The
  // web_sessions_vendor_check constraint restricts `vendor` to the known
  // web-tool vendor set, so we can't use a distinct 'mock_anchor' value.
  // Instead we keep vendor='anchor' and distinguish the mock row via a
  // 'mock_' prefix on vendor_session_id. The browser-tool short-circuit
  // (isMockBrowserSession in standard-tool-handler.ts) detects the
  // prefix. caller_session_id pattern matches the real spawn so any
  // code that reads it as ui:* doesn't misinterpret a mock row.
  const { randomUUID } = await import('crypto');
  const { getPool } = await import('../infrastructure/database');
  const pool = getPool();
  const mockVendorSessionId = `mock_${randomUUID()}`;
  const callerSessionId = `ui:${randomUUID()}`;
  const insertRes = await pool.query(
    `INSERT INTO web_sessions (
       tenant_id, agent_id, thread_id, owner_account_id, caller_session_id,
       vendor, vendor_session_id, vendor_metadata
     ) VALUES ($1, $2, $3, $4, $5, 'anchor', $6, $7)
     RETURNING id`,
    [
      args.tenantId, args.runtimeAgentId, args.threadId, args.ownerAccountId ?? null, callerSessionId,
      mockVendorSessionId,
      JSON.stringify({ _harness_mock: true }),
    ],
  );
  return { id: insertRes.rows[0].id as string, vendorSessionId: mockVendorSessionId };
}

/** invocation-trace lookup. PB's chat-turn harness path (run-chat-router.ts)
 *  drives the agent through the live SDK streaming protocol and doesn't
 *  observe audit_logs or pause-state directly. This endpoint lets the
 *  PB-side runner fetch both for an invocationId AFTER the chat turn ends,
 *  so end-to-end scenarios can assert on the same fields TR-direct runs
 *  surface inline (expectsAuditLogContains, expectsHitlPause). */
router.get('/invocation-trace', async (req: Request, res: Response) => {
  const invocationId = typeof req.query.invocationId === 'string' ? req.query.invocationId : '';
  if (!invocationId) {
    res.status(400).json({ ok: false, error: 'missing invocationId query param' });
    return;
  }
  try {
    const pool = getPoolForService('scheduled-execution');
    const auditRes = await pool.query(
      `SELECT id, action, outcome, error_code, input_args
       FROM audit_logs
       WHERE invocation_id = $1
       ORDER BY created_at ASC
       LIMIT 50`,
      [invocationId],
    );
    const auditLogs = auditRes.rows.map((r: { id: string; action: string; outcome: string; error_code: string | null; input_args: unknown }) => ({
      id: r.id,
      action: r.action,
      outcome: r.outcome,
      errorCode: r.error_code,
      inputArgs: r.input_args,
    }));
    // Pause-state is signalled by a row in hitl_approval_requests (HITL gate)
    // or by the invocation status being a pause-shape. Probe both.
    const hitlRes = await pool.query(
      `SELECT 1 FROM hitl_approval_requests
       WHERE invocation_id = $1 AND status = 'pending' LIMIT 1`,
      [invocationId],
    );
    const pauseState = (hitlRes.rowCount ?? 0) > 0
      ? { kind: 'hitl_approval', reason: 'hitl_gate' }
      : { kind: 'none' };
    res.json({ ok: true, invocationId, auditLogs, pauseState });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, invocationId },
      'test-harness: invocation-trace query failed',
    );
    res.status(500).json({ ok: false, error: 'invocation_trace_failed', message: (err as Error).message });
  }
});

/** Passive diagnostics harvest, run IN tenant-runtime. The agent-diagnostics
 *  Cloud Run Job lives in the control project and cannot reach the per-tenant
 *  TR DB (private VPC) — and user-created evaluation needs the live tool-gateway
 *  (reconstructUserDesignedCatalog → createToolGatewayMcpServer), which is
 *  irreducibly TR-runtime-bound. So the control job calls THIS endpoint, which
 *  reconstructs + evaluates the recent real runs here (DB + tool-gateway local;
 *  judges fall back to the native Vertex judge since DEEPEVAL_SERVICE_URL isn't
 *  set in the TR service) and returns the EvaluatedRun results for the job to
 *  sink to BigQuery. Only evaluated results leave the tenant — no raw run data. */
router.post('/harvest', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    agentKind?: string; tenantId?: string; agentId?: string;
    limit?: number; sinceIso?: string; runJudges?: boolean; runRca?: boolean;
    invocationId?: string; allAgents?: boolean; maxAgents?: number;
    runGrader?: boolean; graderJudges?: string; rubricModel?: string;
    graderMode?: 'oneshot' | 'agentic';
  };
  if (!body.tenantId) {
    res.status(400).json({ ok: false, error: 'tenantId is required' });
    return;
  }
  // allAgents discovers + harvests every active agent on the tenant; otherwise a
  // specific agentId is required (single-agent harvest or canary invocationId).
  if (!body.allAgents && !body.agentId) {
    res.status(400).json({ ok: false, error: 'agentId is required unless allAgents=true' });
    return;
  }
  try {
    const agentKind = (body.agentKind ?? 'user-created') as AgentKind;
    const opts = {
      limit: Number(body.limit ?? 20),
      sinceIso: body.sinceIso,
      runJudges: body.runJudges !== false,
      runRca: body.runRca !== false,
      runGrader: body.runGrader === true,
      graderJudges: body.graderJudges,
      rubricModel: body.rubricModel,
      graderMode: body.graderMode,
    };
    let results;
    if (body.allAgents) {
      // Discover ALL active agents on the tenant (from the invocations source of
      // truth) and harvest each — the per-run refs carry the real agentId.
      results = await harvestAllActiveAgents(body.tenantId, agentKind, { ...opts, maxAgents: Number(body.maxAgents ?? 25) });
    } else {
      const target = { agentKind, tenantId: body.tenantId, agentId: body.agentId! };
      // invocationId → evaluate that ONE run (the active deploy-canary path); else
      // harvest the recent N (the passive path).
      results = body.invocationId
        ? [await harvestOne(target, body.invocationId, opts)]
        : await harvestTarget(target, opts);
    }
    res.json({ ok: true, results });
  } catch (err) {
    logger.warn({ err: (err as Error).message, agentId: body.agentId }, 'diagnostics harvest endpoint failed');
    res.status(500).json({ ok: false, error: 'harvest_failed', message: (err as Error).message });
  }
});

// Backfill one page of historical collab-session rows. Runs in-TR (DB-local);
// the diagnostics job orchestrates pages via the returned nextCursor.
router.post('/collab-backfill', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    tenantId?: string; sinceIso?: string; untilIso?: string;
    cursor?: { completedAt: string; id: string }; pageSize?: number;
  };
  if (!body.tenantId || !body.sinceIso || !body.untilIso) {
    res.status(400).json({ ok: false, error: 'tenantId, sinceIso, and untilIso are required' });
    return;
  }
  try {
    const { backfillPage } = await import('../collab-sessions/backfill');
    const result = await backfillPage({
      tenantId: body.tenantId,
      sinceIso: body.sinceIso,
      untilIso: body.untilIso,
      cursor: body.cursor,
      pageSize: body.pageSize,
    });
    res.json(result);
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId: body.tenantId }, 'collab backfill endpoint failed');
    res.status(500).json({ ok: false, error: 'collab_backfill_failed', message: (err as Error).message });
  }
});

router.post('/spawn-session', async (req: Request, res: Response) => {
  const parseResult = SpawnSessionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ ok: false, error: 'invalid_request', details: parseResult.error.format() });
    return;
  }
  const { tenantId, agentId, threadId, ownerAccountId, initialUrl, idleTimeoutMinutes, allowMockOnFailure } = parseResult.data;
  let runtimeAgentId: string;
  try {
    const pool = getPoolForService('scheduled-execution');
    const internalAgentRow = await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM internal_agent_runtime_mapping
       WHERE internal_agent_id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );
    runtimeAgentId = internalAgentRow.rows[0]?.agent_id ?? agentId;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, tenantId, agentId, threadId },
      'test-harness: spawn-session runtime-agent lookup failed',
    );
    res.status(500).json({ ok: false, error: 'spawn_failed', message: (err as Error).message });
    return;
  }
  try {
    const { createSessionForThread, gotoUrl } = await import('../browser-sessions/session-vendor-proxy');
    const created = await createSessionForThread({
      tenantId,
      agentId: runtimeAgentId,
      threadId,
      ownerAccountId,
      idleTimeoutMinutes: idleTimeoutMinutes ?? 10,
    });
    if (initialUrl) {
      await gotoUrl(created.vendor, created.vendorSessionId, tenantId, initialUrl);
    }
    res.json({
      ok: true,
      session: {
        id: created.id,
        vendor: created.vendor,
        vendorSessionId: created.vendorSessionId,
        ...(initialUrl ? { initialUrl } : {}),
      },
    });
  } catch (err) {
    const errMessage = (err as Error).message;
    logger.error(
      { err: errMessage, tenantId, agentId, threadId, allowMockOnFailure },
      'test-harness: spawn-session real vendor call failed',
    );
    if (allowMockOnFailure) {
      try {
        const mock = await insertMockBrowserSessionRow({ tenantId, runtimeAgentId, threadId, ownerAccountId });
        logger.info(
          { tenantId, agentId, threadId, sessionId: mock.id, reason: errMessage },
          'test-harness: spawn-session fell back to mock session (no vendor session available)',
        );
        res.json({
          ok: true,
          session: {
            id: mock.id,
            vendorSessionId: mock.vendorSessionId,
            ...(initialUrl ? { initialUrl } : {}),
            mocked: true,
            mockReason: errMessage,
          },
        });
        return;
      } catch (mockErr) {
        logger.error(
          { err: (mockErr as Error).message, tenantId, agentId, threadId, originalErr: errMessage },
          'test-harness: spawn-session mock-fallback insert failed',
        );
        // Fall through to surface the original Anchor error below.
      }
    }
    res.status(500).json({ ok: false, error: 'spawn_failed', message: errMessage });
  }
});

const TeardownSessionRequestSchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
});

router.post('/teardown-session', async (req: Request, res: Response) => {
  const parseResult = TeardownSessionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ ok: false, error: 'invalid_request', details: parseResult.error.format() });
    return;
  }
  const { tenantId, threadId } = parseResult.data;
  try {
    const { closeSession: closeSessionRow, endTakeoverHoldForClose, getActiveForThread } = await import('../browser-sessions/repository');
    const { closeSession } = await import('../browser-sessions/session-vendor-proxy');
    const active = await getActiveForThread(tenantId, threadId);
    if (!active?.vendorSessionId) {
      res.json({ ok: true, closed: false, reason: 'no_active_session' });
      return;
    }
    await endTakeoverHoldForClose(active.id).catch(() => {});
    // Mock sessions (vendorSessionId starts with 'mock_') never had a real
    // browser attached, so a close would 404 at whatever vendor owns the row.
    // Just close the row locally so the catalog gate stops seeing it. See
    // standard-tool-handler.ts MOCK_SESSION_ID_PREFIX for the matching
    // detection on the tool dispatch side.
    //
    // The real close goes through the vendor proxy, which dispatches on the
    // row's own vendor. Naming Anchor here left every non-Anchor session
    // running at its vendor and unsettled.
    const isMock = active.vendorSessionId.startsWith('mock_');
    if (!isMock) {
      await closeSession(active.vendor, active.vendorSessionId, tenantId).catch(() => {});
    }
    await closeSessionRow(active.id, 'completed').catch(() => {});
    res.json({ ok: true, closed: true, sessionId: active.id, mocked: isMock });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, tenantId, threadId },
      'test-harness: teardown-session failed',
    );
    res.status(500).json({ ok: false, error: 'teardown_failed', message: (err as Error).message });
  }
});

export { router as testHarnessRouter };
