// MCP-to-function-tool bridge.
//
// Used by the OpenAI adapter to expose Liftoff's in-process tool-gateway
// MCP server as native OpenAI function tools (the @openai/agents SDK has
// no in-process MCP transport — its mcpServers config only accepts URL-
// based remotes). Also the path future Gemini and other non-MCP-native
// SDKs will use.
//
// Function-call dispatch routes through mcp-client-pool, which acquires
// either an HTTP client (remote servers) or an InMemoryTransport-paired
// client (in-process servers — Liftoff tool gateway). The transport choice
// is invisible at this layer; the bridge always speaks MCP.

import type { McpToolCatalog, McpToolDefinition } from './catalog-types';
import type { HitlGate, AnomalyHandler, PauseGateContext, PauseDelegationContext, PlatformMessage, ToolResultObserver } from './types';
import { getMcpClientPool } from './mcp-client-pool';
import { applyCommentAuthorship } from './comment-authorship';
import { flattenToolResultText } from './tool-result-text';
import { envelopeRawToolError } from '../../tool-gateway/tool-error-envelope';
import { interpretMcpToolCallResult, inputRequiredError, toolResultFailure } from '../../tool-gateway/mcp-result';
import { logger } from '../../infrastructure/logging';
import { dispatchTimeoutMs } from './dispatch-timeout';
import { takeGatewayHitlPause } from '../../hitl-enforcement/gateway-pause-signal';
import { frameUntrusted } from '../../workspace/untrusted-content-wrapper';
import { observeToolCall } from '../verify-on-stop';
import { withCompleteness } from '../../tool-gateway/result-completeness';
import type { ParkedResult } from '../../tool-gateway/result-dataset';
import { assertToolAllowedForRole } from '../delegation-roles';
import { parseTieredToolName, searchDeferredTools, type DeferredTool } from './tool-tiering';
import {
  appendContextHints,
  contextHintsForToolCall,
  deriveContextReader,
} from './subdirectory-context';
import { wasBounded } from '../../tool-gateway/observe-result-size';
import {
  boundToolResult,
  maxChars,
  noteTurnUsage,
  spillToolText,
  toolResultBoundEnabled,
  turnBudgetChars,
} from './tool-result-bound';

export interface BridgeContext {
  tenantId: string;
  invocationId: string;
  hitlGate: HitlGate | null;
  anomalyHandler: AnomalyHandler | null;
  /** Stash for the oversight gate signal. When dispatchFunctionCall calls
   *  context.hitlGate and receives `{ allow: false, hitlPause }`, it sets
   *  this field, calls `context.abort()` (tears down the OpenAI run loop
   *  IMMEDIATELY so no further tool calls within the same run can execute
   *  or overwrite this stash), and returns an error-shaped tool result.
   *  The adapter's invoke loop catches the resulting AbortError and emits
   *  `pause_requested(reason: 'hitl_gate', gateContext)` so the outer
   *  hybrid loop can create the approval + persist the hitl_approval pause.
   *  Reset to null at the top of each adapter invoke(). */
  pendingHitlGate?: PauseGateContext | null;
  pendingDelegationPause?: PauseDelegationContext | null;
  /** Set when dispatchFunctionCall detects a {__wakePending} marker in a tool result (self-wake).
   * The adapter's invoke loop reads it and emits pause_requested{self_wake, wakeContext}. */
  pendingWakePause?: import('./types').WakeContext | null;
  /** Owned by the adapter — aborts the OpenAI run() loop so the model
   *  cannot keep emitting tool calls within the same run after a HITL
   *  gate fires. Required because OpenAI's `toolUseBehavior:
   *  'run_llm_again'` would otherwise feed our error-shaped tool result
   *  back to the LLM and continue. */
  abort?: () => void;
  /** Adapter sink for recovery-LLM corrective text. Called when anomalyHandler
   *  returns an injectMessage on a tool error so the adapter can enqueue it
   *  (this.injected) for the next model turn. */
  onRecoveryInject?: (text: string) => void;
  /** Why `abort()` was called, when the bridge called it because the anomaly
   *  handler escalated. Set immediately before the abort so the adapter can
   *  report the cause instead of the SDK's bare "operation was aborted" — an
   *  abort with no reason is indistinguishable from a caller cancelling. */
  recoveryAbortReason?: string | null;
  /** Told each call's outcome, as the tool produced it, and WAITED FOR before
   *  the result goes back to the model — see
   *  VendorSdkAdapter.registerToolResultObserver. Null on an engine that has
   *  not registered one. */
  toolResultObserver?: ToolResultObserver | null;
  /** The ids of the calls the observer above was told about, so the adapter
   *  can mark them `recordedAtDispatch` on the event stream. */
  recordedCalls?: Set<string>;
  /** The agent's filesystem, when it has one.
   *
   *  An oversized tool result is written here in full and replaced inline by a
   *  preview plus the path, so the agent can read the rest instead of losing
   *  it. Absent for connector-only agents (no sandbox exists), in which case
   *  the result is truncated as before. */
  /** B3 spill target — an override.
   *
   *  Normally left unset: the dispatcher derives one from the catalog, because
   *  a file-capable agent already carries `file_write` there (see
   *  deriveSpillTarget). Set this only to point the spill somewhere other than
   *  the run's own sandbox. */
  spillTarget?: { writeFile: (path: string, content: string) => Promise<void> } | null;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function mcpToGeminiFunctions(catalog: McpToolCatalog): GeminiFunctionDeclaration[] {
  return catalog.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema as Record<string, unknown>,
  }));
}

/** OpenAI function-tool descriptor. Matches the shape the @openai/agents
 *  SDK's `tool()` helper produces. */
export interface OpenAiFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Async tool body. The Agent SDK invokes this when the LLM emits a
   *  function_call for `name`; result is JSON-stringified and fed back as
   *  the function_call_output. `call.callId` is the model's id for the call,
   *  handed through so a rejection can be folded into its batch. */
  execute: (args: Record<string, unknown>, call?: { callId?: string }) => Promise<unknown>;
}

/** Convert every catalog tool into an OpenAiFunctionTool whose execute()
 *  dispatches back through the bridge (and hence through the live MCP
 *  server / in-process tool gateway). One BridgeContext is shared across
 *  the returned tools so they all settle through the same hitlGate +
 *  anomalyHandler + invocationId. */
export function mcpToOpenAiFunctionTools(
  catalog: McpToolCatalog,
  context: BridgeContext,
): OpenAiFunctionTool[] {
  return catalog.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema as Record<string, unknown>,
    execute: async (args: Record<string, unknown>, call?: { callId?: string }) => {
      return dispatchFunctionCall(catalog, tool.name, args, context, call);
    },
  }));
}

/** Detect the async spawn_task_graph pause marker in a tool result's content.
 *  Returns the delegation context minus parentToolCallId (the adapter attaches
 *  the tool_use id it knows). */
function extractDelegationPending(result: unknown): Omit<PauseDelegationContext, 'parentToolCallId'> | null {
  try {
    // flattenToolResultText extracts text blocks from the CONTENT ARRAY; passing
    // the whole {content,isError} wrapper would just JSON.stringify it and the
    // nested marker (inside content[0].text) would never parse. Pass .content.
    const content = (result as { content?: unknown })?.content ?? result;
    const text = flattenToolResultText(content);
    if (!text || !text.includes('__delegationPending')) return null;
    const parsed = JSON.parse(text) as { __delegationPending?: { parentTaskId: string; childTaskIds: string[]; deadlineAt: string } };
    const dp = parsed.__delegationPending;
    if (!dp || !dp.parentTaskId) return null;
    return { parentTaskId: dp.parentTaskId, childTaskIds: dp.childTaskIds ?? [], deadlineAt: dp.deadlineAt };
  } catch { return null; }
}

/** Detect the self-wake pause marker {__wakePending: WakeContext} in a tool result's content.
 * Mirrors extractDelegationPending. Returns the full WakeContext the wake tool produced. */
export function extractWakePending(result: unknown): import('./types').WakeContext | null {
  try {
    const content = (result as { content?: unknown })?.content ?? result;
    const text = flattenToolResultText(content);
    if (!text || !text.includes('__wakePending')) return null;
    const parsed = JSON.parse(text) as { __wakePending?: import('./types').WakeContext };
    const w = parsed.__wakePending;
    if (!w || typeof w !== 'object' || !('spec' in w) || !w.spec) return null;
    return w;
  } catch { return null; }
}

/** Match a sanitized server key back to its server id.
 *
 *  The synthetic tool names sanitize the id (non-alphanumerics become
 *  underscores), so the mapping back is not exact string equality. */
function resolveDeferredForServerKey(
  deferred: Map<string, DeferredTool[]>,
  serverKey: string,
): DeferredTool[] | null {
  for (const [serverId, tools] of deferred) {
    if (serverId.replace(/[^A-Za-z0-9_]/g, '_') === serverKey) return tools;
  }
  return null;
}

/** A writer backed by the run's own sandbox, or null when it has none.
 *
 *  A spill that waits for a `spillTarget` nothing sets is dead code. Rather than thread a sandbox session through
 *  the adapters, this reads the capability that is already present — a
 *  file-capable agent carries `file_write` in its catalog, and it dispatches
 *  through the same MCP client the tool call just used. */
function deriveSpillTarget(
  catalog: McpToolCatalog,
  client: { callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> },
): { writeFile: (path: string, content: string) => Promise<void> } | null {
  const hasFileWrite = catalog.tools.some((t) => t.name === 'file_write');
  if (!hasFileWrite) return null;
  return {
    writeFile: async (path: string, content: string): Promise<void> => {
      await client.callTool({ name: 'file_write', arguments: { path, content } });
    },
  };
}

/** Exported for tests: the derivation is the whole difference between a live
 *  spill and dead code, so it is worth asserting directly. */
export const deriveSpillTargetForTest = deriveSpillTarget;

// The per-call budget lives in dispatch-timeout.ts, a module with no
// dependencies, so the opencode adapter can read the longest one without
// importing this bridge (which many suites replace with a partial mock).
export { dispatchTimeoutMs, longestDispatchTimeoutMs } from './dispatch-timeout';

export async function dispatchFunctionCall(
  catalog: McpToolCatalog,
  functionName: string,
  args: Record<string, unknown>,
  context: BridgeContext,
  /** The model's own id for this call, when the engine has one. It travels on
   *  the anomaly so the strike ledger can fold one model turn's rejections
   *  into a single strike; an engine that cannot supply it is accounted per
   *  call. */
  call?: { callId?: string },
): Promise<unknown> {
  // A collapsed vendor server contributes two synthetic tools that
  // no MCP server knows about. They are answered here rather than dispatched.
  const tiered = parseTieredToolName(functionName);
  if (tiered && catalog.deferredVendorTools) {
    const candidates = resolveDeferredForServerKey(catalog.deferredVendorTools, tiered.serverKey);
    if (candidates) {
      if (tiered.kind === 'search') {
        const matches = searchDeferredTools(candidates, String(args.query ?? ''));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              tools: matches,
              note: matches.length === 0
                ? 'Nothing matched. Try different words, or say what you are trying to achieve.'
                : undefined,
            }),
          }],
        };
      }
      // kind === 'call' — resolve the real tool and dispatch it as itself, so
      // every guarantee below (HITL gate, untrusted framing, the result bound)
      // applies exactly as it would have without tiering.
      const wanted = String(args.name ?? '');
      const target = candidates.find((c) => c.name === wanted || c.remoteToolName === wanted);
      if (!target) {
        return {
          content: [{ type: 'text' as const, text: `No tool named "${wanted}" on this integration. Search for it first.` }],
          isError: true,
        };
      }
      const innerArgs = (args.args ?? {}) as Record<string, unknown>;
      return dispatchFunctionCall(
        { ...catalog, tools: [...catalog.tools, target as unknown as McpToolDefinition] },
        target.name,
        innerArgs,
        context,
        call,
      );
    }
  }

  // The dispatch-time half of the role check. Hiding the tool at assembly stops
  // the model reaching for it; this stops a stale catalog, a resumed session
  // assembled under a different role, or a replayed tool call from getting
  // through anyway. Neither half alone is enough — the first is not a control,
  // and the second alone would waste a turn every time.
  assertToolAllowedForRole(functionName, catalog.delegationRole ?? 'orchestrator');

  const tool = catalog.tools.find((t) => t.name === functionName);
  if (!tool) {
    throw new Error(`Function ${functionName} not found in catalog`);
  }

  // What actually gets dispatched. Starts as the model's own arguments and is
  // replaced only when a human reviewer approved a rewritten version of this
  // call, which the gate hands back below.
  let approvedArgs = args;

  if (context.hitlGate) {
    const gateResult = await context.hitlGate({
      toolName: functionName,
      args,
      tenantId: context.tenantId,
      invocationId: context.invocationId,
      // The model's id for the call, when the engine handed one down, so a
      // pause names the call the record holds.
      ...(call?.callId ? { callId: call.callId } : {}),
    });
    // Approve-with-edits. On a structured resume the model re-proposes its OWN
    // draft — the reviewer's edit never reached it — so the gate matches on
    // what the model sent and returns the version a person approved. Dropping
    // it here would send the agent's wording under a human's approval, which is
    // the failure the whole feature exists to prevent. The Anthropic engine
    // does not come through here; it substitutes at its own canUseTool seam.
    if (gateResult.allow && gateResult.updatedInput) {
      approvedArgs = gateResult.updatedInput;
    }
    if (gateResult.allow === false) {
      if (gateResult.hitlPause) {
        // Oversight HITL signal — stash gateContext + ABORT the OpenAI
        // run loop. Without the abort, OpenAI's `toolUseBehavior:
        // 'run_llm_again'` would feed our error-shaped tool result back
        // to the LLM and the run would continue: the model could emit
        // further (potentially non-gated) tool calls that actually
        // execute, and if a second gated tool fired in the same run,
        // pendingHitlGate would be overwritten — losing the first
        // approval. The adapter's invoke loop catches the AbortError
        // and emits pause_requested. We still return an error-shaped
        // result here as a fallback in case the abort somehow doesn't
        // tear down the call before openai/agents inspects the return
        // value.
        context.pendingHitlGate = gateResult.hitlPause;
        if (context.abort) context.abort();
        return { error: 'paused_for_human_approval', reason: gateResult.hitlPause.gateReason };
      }
      // Reached only for a HARD policy block: something genuinely not approvable, so
      // there is deliberately no approval to create. An OVERSIGHT decision must never
      // land here — it must carry `hitlPause` above so the user has something to grant.
      //
      // This path previously absorbed oversight denials too, which is how a blocked
      // call produced no approval, nothing in /dashboard/review, and no audit record.
      // Log it so a decision that lands here is visible rather than looking to the
      // model like an ordinary tool error.
      logger.error('governance: hard deny with no approvable pause', {
        tool_name: functionName,
        tenant_id: context.tenantId,
        invocation_id: context.invocationId,
        reason: gateResult.reason ?? 'unspecified',
      });
      const denied = { error: 'HITL gate denied', reason: gateResult.reason };
      await observeOutcome(context, functionName, args, call, denied, denied.error);
      return denied;
    }
  }

  const server = findServerForTool(catalog, tool);
  if (!server) {
    throw new Error(`No MCP server registered for tool ${functionName}`);
  }


  const pool = getMcpClientPool();
  const client = await pool.acquire(context.invocationId, server);

  // What is actually sent, once the gate's approved edits and the comment
  // authorship stamp are applied. Declared here so a dispatch that throws is
  // observed with the arguments it was made with, not the model's originals.
  let dispatchArgs: Record<string, unknown> = approvedArgs;
  try {
    // Remote vendor MCP tools carry a namespaced model-facing `name`
    // (collision safety) but the vendor server dispatches on the BARE tool
    // name — sent via `remoteToolName`. In-process gateway tools leave
    // `remoteToolName` undefined, so the namespaced `functionName` IS the wire
    // name. The HITL gate above (and the recovery firing below) read the
    // namespaced `functionName`; only the wire `tools/call` reads the bare name.
    // Name the authoring team on comments written to GitHub / GitLab. Placed
    // after the HITL gate above deliberately: oversight judges the model's own
    // arguments, and this only rewrites what is dispatched. Matched on the
    // namespaced `functionName` (`mcp__github-<connector>__…`), since the bare
    // wire name carries no server. No-ops for everything that is not a
    // code-host comment. The Anthropic engine never reaches this path and is
    // stamped at its `canUseTool` seam instead.
    dispatchArgs = (await applyCommentAuthorship(functionName, approvedArgs, {
      tenantId: context.tenantId,
      invocationId: context.invocationId,
    })) ?? approvedArgs;
    const result = await client.callTool(
      { name: tool.remoteToolName ?? functionName, arguments: dispatchArgs },
      undefined,
      { timeout: dispatchTimeoutMs(dispatchArgs) },
    );
    // Observe here, on the RAW result, before framing and bounding rewrite
    // it. What we want to know is what the tool actually did, not what the model
    // will be shown. Records the dispatched args, so the trajectory shows the
    // comment as it was actually posted.
    observeToolCall(context.invocationId, functionName, dispatchArgs, result);
    // Remembered HERE, on a COPY of the raw result, and waited for, before the
    // model can act on what came back. A copy because the untrusted framing
    // below rewrites `result.content` in place. The event stream carries the
    // MODEL-FACING result — framed, bounded — and must keep doing so: it is
    // persisted and replayed into later model contexts, where the frame is
    // the boundary. The raw data goes to the observer and nowhere else. And
    // the engine does not wait for stream listeners before its next model
    // turn, so a write judged there could precede the record of the read it
    // stands on; here it cannot.
    const rawCopy = structuredClone(result);
    await observeOutcome(context, functionName, dispatchArgs, call, rawCopy, toolResultFailure(rawCopy));
    // MCP 2026-07-28 MRTR: a resultType:"input_required" interim result means the
    // vendor server needs interactive input (elicitation/sampling/roots) before
    // it can complete. This SDK dispatch path can't fulfil that synchronously, so
    // envelope it into the uniform TOOL_ERROR contract (like an isError result)
    // instead of feeding the interim result back to the model as a normal result.
    if (interpretMcpToolCallResult(result).inputRequired) {
      const text = inputRequiredError(tool.remoteToolName ?? functionName);
      await fireRecovery(context, functionName, text, dispatchArgs, call?.callId);
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
    // A gate the handler itself raised at execute time (the message check
    // under Send automatically, mcp-server.ts): the in-process McpServer turns
    // the handler's throw into an error result, and the signal it recorded
    // first is what survives. Drained here, the same way the Anthropic engine
    // drains it after its query, so the pause reaches a person on every
    // engine rather than reading to the model as a failed tool.
    if (isToolResultError(result) && !context.pendingHitlGate) {
      const gatewayPause = takeGatewayHitlPause(context.invocationId);
      if (gatewayPause) {
        context.pendingHitlGate = {
          gateReason: gatewayPause.reason,
          pendingToolCalls: [{ id: call?.callId ?? `pending-gateway-${functionName}`, name: functionName, input: gatewayPause.args }],
          ...(gatewayPause.matchedCategory ? { matchedCategory: gatewayPause.matchedCategory } : {}),
          ...(gatewayPause.context ? { context: gatewayPause.context } : {}),
        };
        if (context.abort) context.abort();
        return { error: 'paused_for_human_approval', reason: gatewayPause.reason };
      }
    }
    if (isToolResultError(result)) {
      const rawText = extractToolErrorText(result);
      // Vendor-hosted MCP tools (remoteToolName set) bypass the in-process
      // tool-gateway's buildToolErrorContent — classify + envelope here so the
      // model reads the uniform TOOL_ERROR contract AND the recovery path can
      // parse it (fast-trip instead of a wasted recovery-LLM turn). In-process
      // gateway tools already return TOOL_ERROR → envelopeRawToolError returns
      // null (idempotent) → pass through unchanged.
      const envelope = tool.remoteToolName ? envelopeRawToolError(rawText) : null;
      await fireRecovery(context, functionName, envelope ?? rawText, dispatchArgs, call?.callId);
      if (envelope) {
        return { content: [{ type: 'text' as const, text: envelope }], isError: true };
      }
    }
    // Async spawn_task_graph returns a {__delegationPending:{…}} marker in its
    // content. Stash it so the adapter pauses; the adapter fills parentToolCallId
    // (the tool_use id only it knows) when it detects the flag. Tear down the
    // OpenAI run() loop the same way HITL does (context.abort) so the model can't
    // keep emitting tool calls with the marker fed back as a normal tool result;
    // no-op for Gemini's manual loop, which polls the flag after each dispatch.
    const dp = extractDelegationPending(result);
    if (dp) {
      context.pendingDelegationPause = { ...dp, parentToolCallId: '' };
      if (context.abort) context.abort();
    }
    // Self-wake: detect the __wakePending marker + abort so the model can't keep emitting tool calls
    // with the marker fed back as a normal result. Batch-collision guard: only the FIRST
    // terminal pause-control call in a turn wins — do not overwrite an existing pending pause.
    const wk = extractWakePending(result);
    if (wk && !context.pendingWakePause && !context.pendingDelegationPause && !context.pendingHitlGate) {
      context.pendingWakePause = wk;
      if (context.abort) context.abort();
    }
    // Did this call move the run into a directory whose conventions it has
    // not been shown? Computed here rather than at the return sites because
    // there are three of them; delivered by appending to the tool RESULT below,
    // never the system prompt, so the cached prefix is untouched.
    //
    // Skipped for delegation markers: that result is a control signal the
    // adapter parses, and appending prose to it would break the parse.
    const contextHints = dp ? [] : await contextHintsForToolCall(
      context.invocationId,
      functionName,
      args,
      deriveContextReader(catalog),
    );
    if (contextHints.length > 0 && toolResultBoundEnabled()) {
      // The hints are appended AFTER the per-result bound on purpose — a large
      // tool result must not be able to truncate a conventions file down to half
      // a sentence, which reads as guidance and is not. They are separately
      // capped, and counted here so the turn budget still sees them.
      noteTurnUsage(context.invocationId, contextHints.reduce((n, h) => n + h.length, 0));
    }

    // Frame vendor-hosted results as untrusted DATA so injected "instructions" in
    // vendor output aren't obeyed. ONLY for remoteToolName (vendor) tools: in-process
    // gateway results are already framed at the mcp-server, so framing them here would
    // double-frame. Skip delegation markers (handled above) and error results (enveloped above).
    if (tool.remoteToolName && !dp && !isToolResultError(result) && Array.isArray(result?.content)) {
      result.content = result.content.map((c) =>
        c && c.type === 'text' && typeof c.text === 'string'
          ? { ...c, text: frameUntrusted(`vendor:${functionName}`, c.text, undefined, { tenantId: context.tenantId, invocationId: context.invocationId }) }
          : c);
    }
    // Deterministic size bound for the OpenAI/OpenRouter/Gemini loops (this
    // bridge). Runs AFTER framing so the untrusted-frame delimiters are present
    // and preserved. Off unless TOOL_RESULT_BOUND_ENABLED=1. Skips error/
    // delegation results (isError guarded; delegation aborts above). Anthropic
    // never reaches this bridge, so it is unaffected.
    // `wasBounded` — the gateway wrapper now spills, bounds and counts every
    // IN-PROCESS tool result, on every engine, so re-running that here would
    // count the same characters against the turn budget twice and trip the
    // aggregate at half its configured size. Remote vendor-MCP tools are not
    // gateway-wrapped and still need this block, which is why it stays.
    if (toolResultBoundEnabled() && !dp && !wasBounded(result)) {
      // Prefer spilling over truncating: same context cost, nothing lost.
      // Falls through to the bound when there is no filesystem to spill to, or
      // when the write fails.
      //
      // The spill target is derived, not injected: an agent with file
      // capability already has `file_write` in this very catalog, dispatched
      // through the same client. So "can this run spill?" is exactly "is
      // file_write registered?" — no sandbox handle has to be threaded down
      // here, and a connector-only agent (no filesystem, no file_write)
      // correctly falls through to the bound.
      let spilledFull: ParkedResult | undefined;
      const spillTarget = context.spillTarget ?? deriveSpillTarget(catalog, client);
      if (spillTarget && Array.isArray(result?.content)) {
        const limit = maxChars();
        for (let i = 0; i < result.content.length; i++) {
          const block = result.content[i] as { type?: string; text?: string };
          if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= limit) continue;
          const spilled = await spillToolText(
            block.text,
            spillTarget,
            `${context.invocationId}-${functionName}-${i}`,
          );
          if (spilled) {
            result.content[i] = { ...block, text: spilled.text };
            // A spilled block means context now holds a VIEW of this result.
            // Recorded as structure on the returned result so a caller that may
            // only act on the whole thing can tell, instead of having to notice
            // the note inside the text.
            //
            // `text`, not `json`: the spill writes the tool's own output to a
            // .txt verbatim, and a bounded block is frequently not JSON. Naming
            // it json would send a reader to a parser that fails.
            spilledFull = { path: spilled.path, bytes: spilled.bytes, format: 'text' };
          }
        }
      }

      const bounded = boundToolResult(result) as { content?: Array<{ text?: string }> };

      // Aggregate budget: one result under the per-result cap can still be one
      // of twenty. Past the turn budget, later results are bounded hard so a
      // long tool-heavy turn cannot accumulate its way past the window.
      const size = Array.isArray(bounded?.content)
        ? bounded.content.reduce((n, c) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0)
        : 0;
      const used = noteTurnUsage(context.invocationId, size);
      if (used > turnBudgetChars() && Array.isArray(bounded?.content)) {
        logger.info(
          { invocationId: context.invocationId, used, budget: turnBudgetChars(), tool: functionName },
          'tool_result_turn_budget_exceeded',
        );
        return withSpillCompleteness(appendContextHints(
          boundToolResult(bounded, Math.max(1_000, Math.floor(maxChars() / 4))),
          contextHints,
        ), spilledFull);
      }
      return withSpillCompleteness(appendContextHints(bounded, contextHints), spilledFull);
    }
    return appendContextHints(result, contextHints);
  } catch (err) {
    const rawMessage = (err as Error).message;
    // A thrown tool call is still an observation. A verifier that threw is
    // a verifier that did not pass, and that distinction is the whole gate.
    observeToolCall(context.invocationId, functionName, args, { isError: true, output: rawMessage });
    logger.warn(
      { err: rawMessage, invocationId: context.invocationId, tool: functionName },
      'mcp_bridge_dispatch_failed',
    );
    // A THROWN vendor-MCP error (e.g. a 404 surfaced by the vendor server as an
    // McpError) must be classified into the uniform TOOL_ERROR contract too —
    // not only isError RESULTS above. For remote (vendor-hosted) tools, envelope
    // the thrown message and return it as an isError result so the model reads
    // the same contract as every other path, and recovery can fast-trip on it.
    // In-process gateway tools keep the legacy `{ error }` shape (their errors
    // are already normalized upstream by buildToolErrorContent).
    const envelope = tool.remoteToolName ? envelopeRawToolError(rawMessage) : null;
    await fireRecovery(context, functionName, envelope ?? rawMessage, args, call?.callId);
    await observeOutcome(context, functionName, dispatchArgs, call, { error: rawMessage }, rawMessage);
    if (envelope) {
      return { content: [{ type: 'text' as const, text: envelope }], isError: true };
    }
    return { error: rawMessage };
  }
}

/**
 * Tell the registered observer what one call produced, and wait.
 *
 * Three exits of `dispatchFunctionCall` are a model's call with an outcome: a
 * gate that refused it, a tool that returned, a dispatch that threw. A pause
 * is none of those — nothing has happened yet, and the resumed run will make
 * the call again. Never throws: the observer is the platform's to keep
 * non-fatal, and a failure to remember is not a failure of the call.
 */
async function observeOutcome(
  context: BridgeContext,
  functionName: string,
  args: Record<string, unknown>,
  call: { callId?: string } | undefined,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  if (!context.toolResultObserver) return;
  try {
    const rememberedNow = await context.toolResultObserver({
      toolName: functionName,
      args,
      ...(call?.callId ? { callId: call.callId } : {}),
      result,
      ...(error ? { error } : {}),
    });
    // Marked only when the observer says the record EXISTS. A record that
    // timed out or failed is not one the stream may skip.
    if (rememberedNow && call?.callId) context.recordedCalls?.add(call.callId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tool: functionName, invocationId: context.invocationId },
      'tool_result_observer_failed (non-fatal)',
    );
  }
}

function findServerForTool(catalog: McpToolCatalog, tool: McpToolDefinition) {
  return catalog.servers.find((s) => s.id === tool.serverId);
}

async function fireRecovery(
  context: BridgeContext,
  functionName: string,
  errorText: string,
  args: Record<string, unknown>,
  callId: string | undefined,
): Promise<void> {
  if (!context.anomalyHandler) return;
  const decision = await context.anomalyHandler({
    kind: 'tool_call_error',
    context: { toolName: functionName, error: errorText, args, callId },
    invocationId: context.invocationId,
  });
  if (decision.injectMessage && context.onRecoveryInject) {
    context.onRecoveryInject(injectMessageToText(decision.injectMessage));
  }
  // `escalate` is the handler saying this run must stop rather than take
  // another turn at the same thing. Declared on AnomalyHandler and, until now,
  // read by nothing — so a handler whose only answer is escalate (the
  // workflow-step one, which exists to hand anomalies to the outer recovery
  // authority) was heard as "carry on", and the model kept re-issuing a call
  // that had just been rejected until its turn budget ran out.
  //
  // Stopping the loop is all this does. What the stop MEANS is the caller's:
  // the adapter reports an error completion and the hybrid loop routes it the
  // way it routes any failed step.
  if (decision.escalate && context.abort) {
    context.recoveryAbortReason =
      `run stopped after "${functionName}" failed and recovery declined another attempt: `
      + errorText.slice(0, 500);
    logger.warn(
      { invocationId: context.invocationId, tool: functionName },
      'recovery_escalated_abort',
    );
    context.abort();
  }
}
function isToolResultError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}
function extractToolErrorText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  // Content present → reduce via the shared flattener so the TOOL_ERROR
  // envelope stays parseable (same reduction the Anthropic hook uses). No
  // content → stringify the whole result as a last resort.
  return content !== undefined && content !== null
    ? flattenToolResultText(content)
    : JSON.stringify(result);
}
function injectMessageToText(msg: PlatformMessage): string {
  return msg.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
}

/** Attach completeness to a bounded result when a block of it was spilled.
 *  A no-op when nothing spilled, so a result that fit keeps today's shape and
 *  carries no claim either way — absence of the field means unmeasured, which is
 *  the honest reading. */
function withSpillCompleteness<T>(result: T, full: ParkedResult | undefined): T {
  return full ? withCompleteness(result, { complete: false, full }) : result;
}
