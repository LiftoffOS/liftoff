// Resolve the tool name a model actually calls back to its catalog entry.
//
// The Agent SDK exposes MCP tools to the model as `mcp__<serverId>__<toolName>`.
// Our catalog registers the un-prefixed `<toolName>` — for connector tools that is
// `<connectorAlias>__<fn>`, e.g. `slack-d77db9a0__send_message` (mcp-server.ts:371).
//
// Every governance lookup was written as `tools.find(t => t.name === call.name)`, which
// compares the prefixed call name against un-prefixed catalog names and therefore never
// matches for ANY connector tool. The consequences were silent, because the callers all
// treat "not found" as "nothing to enforce":
//
//   - the sensitive-work check read `tool?.categories` off `undefined`, so no category
//     could ever match and the gate cleared calls it should have gated
//   - `if (callTool) { maybeConvertToDraft(...) }` skipped its entire body, so the
//     draft-mode pre-check never ran
//
// For example, a call to `mcp__liftoff-tool-gateway__slack-<id>__send_message`
// matched nothing, was allowed, then died at execute time with no approval and
// `outcome=success`.
//
// This module is the single place that parsing lives, so the fix cannot drift back apart
// across the three call sites.

import type { ToolCallRequest, ModelTool } from './types';

/** Prefix the Agent SDK puts on every MCP-served tool. */
const SDK_MCP_PREFIX = 'mcp__';

/**
 * Raised when a called tool cannot be found in the catalog.
 *
 * This is a system fault, not a policy outcome, and the two must not be conflated: a
 * resolved tool with `categories: []` is the ordinary case (21 catalog tools have it)
 * and correctly does not gate. An unresolved NAME means the catalog and the caller
 * disagree, which no human approver can adjudicate — so it fails the run instead of
 * quietly allowing it or manufacturing an approval nobody can reason about.
 */
export class UnresolvedToolError extends Error {
  public readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Governance could not resolve tool "${toolName}" against the registered catalog. ` +
      'This is a catalog/caller mismatch, not an oversight decision.',
    );
    this.name = 'UnresolvedToolError';
    this.toolName = toolName;
  }
}

/** Server id of the in-process gateway whose catalog we own and register ourselves. */
const OWN_GATEWAY_SERVER_ID = 'liftoff-tool-gateway';

/**
 * True when a call name came from OUR gateway, so we are entitled to expect it in the
 * catalog.
 *
 * This distinction is load-bearing. Remote vendor-MCP servers expose tools we never
 * register — by design, documented in
 * `runAdapterHitlGate-wrap-fallback.test.ts`: *"vendor-MCP tools aren't in modelTools and
 * can't be run through maybeConvertToDraft (no categories to evaluate)"*. Risky ones are
 * caught by name in checkHitlGate instead.
 *
 * So "unresolved" has a legitimate population, and treating every miss as a defect would
 * fail every vendor-MCP call. Only a miss on `mcp__liftoff-tool-gateway__…` means the
 * catalog and the caller genuinely disagree.
 */
export function isOwnGatewayTool(callName: string): boolean {
  return callName.startsWith(`${SDK_MCP_PREFIX}${OWN_GATEWAY_SERVER_ID}__`);
}

/**
 * Recover the catalog name from whatever the model called.
 *
 * `mcp__liftoff-tool-gateway__slack-d77db9a0__send_message`
 *   → `slack-d77db9a0__send_message`
 *
 * The tool name itself contains `__` (connector alias + function), so only the FIRST
 * separator after the server id may be consumed. Names without the prefix pass through
 * untouched, which keeps standard/in-process tools working unchanged.
 */
/**
 * Pseudo-connector prefixes our OWN dispatch layer composes onto a bare catalog
 * name. `agent_slack__slack_send_message` is what reaches the gate;
 * `slack_send_message` is what the catalog holds.
 *
 * These are not connectors. There is no `agent_slack` integration — the family
 * resolver invents the segment so the dispatcher knows which handler to use, and
 * a real connector tool (`google-mail-0105297e__send_email`) is registered under
 * its full aliased name and needs no stripping. So this is an explicit list, not
 * a general "take the last segment" rule, which would collapse real connector
 * tools onto each other.
 */
const PSEUDO_CONNECTOR_PREFIXES: readonly string[] = [
  'agent_slack__',
  'agent_teams__',
  'execution_environment__',
];

/**
 * The name the DISPATCHER routes on: the call name with only the SDK's
 * `mcp__<server>__` wrapper removed.
 *
 * `mcp__liftoff-tool-gateway__run_capability`               → `run_capability`
 * `mcp__liftoff-tool-gateway__google-mail-0105297e__send_email` → `google-mail-0105297e__send_email`
 * `mcp__liftoff-tool-gateway__agent_slack__slack_send_message`  → `agent_slack__slack_send_message`
 *
 * Unlike `normalizeToolName` it keeps a pseudo-connector segment and a connector
 * alias intact, because the dispatcher reads the connector off the first `__`
 * and routes a pseudo-connector to its own handler; collapsing either would
 * send the call to the wrong family. A name without the wrapper passes through
 * unchanged, and a malformed `mcp__x` (no second separator) is returned as-is so
 * the caller's not-found handling reports it rather than this inventing a name.
 */
export function dispatchNameFor(callName: string): string {
  if (!callName.startsWith(SDK_MCP_PREFIX)) return callName;
  const afterPrefix = callName.slice(SDK_MCP_PREFIX.length);
  const sep = afterPrefix.indexOf('__');
  if (sep === -1) return callName;
  return afterPrefix.slice(sep + 2);
}

export function normalizeToolName(callName: string): string {
  for (const p of PSEUDO_CONNECTOR_PREFIXES) {
    if (callName.startsWith(p)) return callName.slice(p.length);
  }
  const bare = dispatchNameFor(callName);
  if (bare === callName) return callName;
  // The SDK form can wrap a pseudo-connector name too
  // (`mcp__liftoff-tool-gateway__agent_slack__slack_send_message`), so strip
  // that as well rather than resolving the prefixed name against a catalog that
  // never held it.
  for (const p of PSEUDO_CONNECTOR_PREFIXES) {
    if (bare.startsWith(p)) return bare.slice(p.length);
  }
  return bare;
}

/**
 * Find the catalog entry for a call name, exact match first so nothing that already
 * resolves changes behaviour.
 *
 * Returns undefined only when the catalog genuinely has no such tool. After this module
 * is wired in, that means the catalog and the caller disagree — a defect, which callers
 * must surface loudly rather than treat as "no policy applies" (see item 2 of the plan).
 */
export function resolveCatalogTool<T extends { name: string }>(
  callName: string,
  tools: readonly T[] | undefined,
): T | undefined {
  if (!tools || tools.length === 0) return undefined;
  const exact = tools.find((t) => t.name === callName);
  if (exact) return exact;

  // Alias-qualified: strip ONLY the SDK's `mcp__`, keeping `<alias>__<tool>`.
  //
  // Two catalogs, two conventions. `normalizeToolName` strips the prefix AND the
  // server segment because the gateway catalog stores the bare `<tool>`. The
  // adapter's vendor-MCP enumeration stores `composeToolName(server.id, name)`
  // — `<alias>__<tool>` — so neither the raw call name nor the fully bare name
  // matches it, and the lookup missed every vendor MCP tool.
  //
  // A miss is not neutral: it reads as an unknown tool, unknown fails closed,
  // and on an untrusted-inbound run that turns a declared read-only search into
  // an approval card. Tried between the two existing candidates so anything
  // that resolves today resolves identically.
  if (callName.startsWith(SDK_MCP_PREFIX)) {
    const aliasQualified = callName.slice(SDK_MCP_PREFIX.length);
    const viaAlias = tools.find((t) => t.name === aliasQualified);
    if (viaAlias) return viaAlias;
  }

  const normalized = normalizeToolName(callName);
  if (normalized === callName) return undefined;
  return tools.find((t) => t.name === normalized);
}

/**
 * In-process bookkeeping tools, which can never require approval.
 *
 * These are the agent writing in its own notebook. `record_step_output` hands a
 * step's result to the next step; `report_task_outcome` records the agent's own
 * verdict on the run. Neither leaves the process: no connector, no network, no
 * file, no message. There is nothing for a human to approve, and an approval
 * card for one is unanswerable — a person cannot meaningfully consent to an
 * agent remembering its own intermediate result.
 *
 * Recognised by NAME rather than by looking them up in the catalog, which is the
 * point. If the catalog list the gate consults goes stale and
 * `record_step_output` is not in it, the miss reads as "unknown tool", unknown
 * fails closed, and a run stalls on an approval to write down a step result.
 * Stale caches are handled separately; this
 * makes the outcome impossible rather than unlikely, because failing closed on an
 * unknown tool is correct behaviour that should not have to be lucky about
 * lookups for this class.
 *
 * Matches bare and `mcp__`-prefixed forms — the SDK calls the prefixed name and
 * the catalog stores the bare one, which is exactly the mismatch that caused
 * this.
 */
const IN_PROCESS_BOOKKEEPING_TOOLS: readonly string[] = [
  'record_step_output',
  'report_task_outcome',
  // The agent writing a line into its own audit trail. Same shape as the two
  // above — a row in this platform's table, no vendor, no person — and the
  // step the templates ask for right after a review is posted, so gating it
  // asked permission to record that permitted work was done.
  'audit_log',
];

/** Telling the person who owns the agent, in the product they own.
 *
 * The external-content gate asks whether an action can be steered by untrusted
 * text. For an action that LEAVES the workspace — a GitHub comment, an email, a
 * CRM write — that is the right question, and the answer decides whether a
 * human should see it first.
 *
 * The Liftoff chat is not that. A message here is read by the people the agent
 * reports to, in a thread they opened, and reading a sentence is not acting on
 * it. Gating it does not contain a risk; it removes the agent's only way to say
 * what it did.
 *
 * The effect of gating it is visible and absurd: a reviewer agent posts its
 * review to a public pull request ungated, and then needs a human to approve
 * telling its owner that it has (reason `external_content_write`, on a step
 * its own approved workflow declares).
 *
 * `notifications_send` belongs here too, and the reason it looked like it did
 * not is worth stating: it can be delivered as email, which reads as leaving.
 * It is not. Every recipient form it accepts is a workspace identity —
 * `user:<account_id>`, `role:admin`, `agent:<id>` resolving to that agent's
 * owner — and there is no way to address a raw mailbox. The audience is the
 * same people the chat reaches; email is the transport one of them chose. What
 * decides this gate is WHO receives it, not which pipe it travels down.
 *
 * `notify_team` is the third and it is the same surface reached a different
 * way: the team's own chat page, which needs no connector and therefore exists
 * for every team. It was written to be the destination that always exists, so
 * gating it removes the last one an unconnected team has.
 *
 * THE MEMBERSHIP RULE, because this list has already gone stale once: a tool
 * belongs here when its message lands on a surface Liftoff owns and only the
 * workspace's own people can read. Not who wrote it, not how it travels, not
 * whether the word "notification" appears in its name. A tool that can address
 * anyone outside the workspace fails the rule however internal it looks.
 * `own-workspace-chat-ungated.test.ts` enumerates every registered tool against
 * this rule, so a new one cannot land unclassified.
 *
 * Same matching discipline as the bookkeeping list above: exact on the
 * normalized name, so `alias__open_chat_thread` — somebody else's connector
 * tool — is not exempted by a coincidence of spelling. */
const OWN_WORKSPACE_CHAT_TOOLS: readonly string[] = [
  'open_chat_thread',
  'notifications_send',
  'notify_team',
  // The request for the person to take the browser over lands in the browser
  // pane beside this workspace's own chat, and nowhere else: the same surface
  // as the chat, reached for the one thing only a person there can do.
  // Held for approval it would be an approval card asking whether the person
  // may be asked, while the browser stays where it is.
  'ask_person_to_take_over_browser_session',
  // Showing a file that is ALREADY in this workspace, in the conversation the
  // person is already reading. It sends nothing anywhere: the bytes were
  // stored and authorised before this ran, the card lands on the same surface
  // as the reply, and nobody outside the workspace can be addressed by it.
  // Held for approval it would be an approval card asking whether somebody may
  // be shown a file they asked for.
  'show_file',
];

export function isOwnWorkspaceChatTool(callName: string): boolean {
  return OWN_WORKSPACE_CHAT_TOOLS.includes(normalizeToolName(callName));
}

/** Waiting on itself.
 *
 *  A wake tool suspends THIS run and resumes it on a trigger: it reaches no
 *  system, writes no record and tells nobody anything. What the run does
 *  after it wakes is gated then, under the trust the wake carries forward
 *  (`originTrust` on the marker, `childTrust` on the resume) — so holding the
 *  wait itself for approval protects nothing, and costs the run its wait.
 *
 *  Held, it could not even be approved: the approved dispatch runs standard
 *  and connector tools, and a wake tool is neither, so the approval failed,
 *  the model asked to wait again, and every approval bought one more copy of
 *  the same question. A run woken by an inbound event that wanted to sleep an
 *  hour was un-approvable. */
const SELF_WAKE_TOOLS: readonly string[] = [
  'sleep_until',
  'wake_on_event',
  'wake_on_job',
  'wake_on_poll',
  'wake_on_any',
  'wake_on_all',
  'cancel_wake',
];

/** Acting only on this platform.
 *
 *  The contract check (contract-check.ts) asks whether a call does what the
 *  team was built and approved to do, and the answer is only meaningful for a
 *  call that reaches the world the team was hired into: a connector, a page,
 *  a person outside. These tools change nothing out there. They write to this
 *  platform's own tables (a memory, a note, a proposal), speak to the
 *  workspace's own teams and people (a colleague brought in, a teammate
 *  messaged, a task delegated), schedule the agent's own work, or manage a
 *  platform browser session. A distilled contract never names them — no
 *  instruction says "and you may remember things" — so judged against it they
 *  read as outside, and the check can gate a reviewer agent for bringing the
 *  Chief AI Officer into its own chat.
 *
 *  THE MEMBERSHIP RULE: a tool belongs here when the call, whatever its
 *  arguments, changes nothing outside this platform and reaches nobody outside
 *  this workspace. A tool that can reach a page, a vendor or a mailbox stays
 *  out however internal it looks; `web_task`, `run_browser_task`,
 *  `navigate_browser_session`, `act_in_browser_session` and `code_session` act
 *  outside and stay eligible. The three lists beside this one (bookkeeping,
 *  own-workspace chat, self-wake) are exempt for their own reasons and by
 *  their own predicates; this list holds only what they do not.
 *  `contract-check-eligibility.test.ts` enumerates every registered tool
 *  against the rule, so a new one cannot land unclassified. */
const PLATFORM_OWN_TOOLS: readonly string[] = [
  // The agent's own store.
  'memory_save',
  'note_save',
  'note_delete',
  'task_ledger_write',
  // A proposal to the person, answered by the person.
  'propose_routine',
  // The workspace's own teams and assistants.
  'bring_in_colleague',
  'delegate_task',
  'delegate_to_agent',
  'spawn_child_task',
  'spawn_task_graph',
  'send_agent_message',
  // The agent's own scheduling.
  'schedule_followup',
  'cancel_followup',
  'run_routine_now',
  // A platform browser session, opened, kept or closed; the page it shows is
  // acted on by other tools, which stay eligible.
  'start_browser_session',
  'web_session_save',
  'web_session_forget',
  'web_session_close',
  // Asks the person to log in somewhere: reaches the person, in this
  // workspace's own chat, and nothing else.
  'web_identity_connect',
  // An artifact surfaced in this workspace's own chat.
  'save_active_browser_page_as_pdf',
];

export function isPlatformOwnTool(callName: string): boolean {
  // Exact match on the normalized name, for the reason isInProcessBookkeepingTool
  // gives: a connector tool that merely ends the same way is somebody else's.
  return PLATFORM_OWN_TOOLS.includes(normalizeToolName(callName));
}

export function isSelfWakeTool(callName: string): boolean {
  // Exact match on the normalized name, for the reason isInProcessBookkeepingTool
  // gives: a connector tool that merely ends the same way is somebody else's.
  return SELF_WAKE_TOOLS.includes(normalizeToolName(callName));
}

export function isInProcessBookkeepingTool(callName: string): boolean {
  // Exact match on the normalized name, deliberately. An `endsWith('__name')`
  // clause would also exempt a CONNECTOR tool that happened to end the same way
  // — `alias__record_step_output` is somebody else's tool reaching somebody
  // else's system, and exempting it from approval by coincidence of naming is
  // the kind of over-broad match that is discovered years later.
  const bare = normalizeToolName(callName);
  return IN_PROCESS_BOOKKEEPING_TOOLS.includes(bare);
}

/**
 * The SDK-form call name for a call made on ANY engine, with the arguments the
 * named tool actually received.
 *
 * Two engine families name the same tool differently. The Claude Agent SDK
 * calls `mcp__<serverId>__<tool>`; every engine behind the function-tool bridge
 * calls the bare `<serverId>__<tool>`, and on a collapsed vendor server it calls
 * the wrapper `call_<server>_tool` with the real name and arguments INSIDE
 * `args`. The seams that remember a call the gateway never dispatched — the
 * action ledger, the provenance guard, the provenance recorder — all parse the
 * SDK form, so on the bridge every vendor-hosted call parsed as nothing: no
 * ledger row, no verdict, no record, and `have_i_acted_on` answering "no" for a
 * review posted a minute earlier.
 *
 * The bare form cannot be parsed on its own. `google-mail-0105297e__create_draft`
 * is one of OUR gateway's tools and `github-dd4c4689__pull_request_read` is a
 * vendor's, and by name they are the same shape; only the catalog's `serverId`
 * says which — so the catalog is a parameter, and this is the one place the
 * two conventions meet.
 *
 * Returns the input unchanged for a name already in SDK form, for a search
 * wrapper (not an action), and for a name the catalog does not know.
 */
export function sdkCallNameFor(
  catalog: {
    tools: ReadonlyArray<{ name: string; serverId: string; inputSchema?: unknown }>;
    deferredVendorTools?: ReadonlyMap<string, ReadonlyArray<{ name: string; remoteToolName?: string; serverId: string; inputSchema?: unknown }>>;
  } | undefined,
  toolName: string,
  args: Record<string, unknown> | undefined,
): { toolName: string; args: Record<string, unknown> | undefined; inputSchema?: unknown } {
  if (!catalog || toolName.startsWith(SDK_MCP_PREFIX)) return { toolName, args };

  // The two tools a collapsed server contributes carry that server's id in the
  // catalog, but neither IS a vendor call: the search is a lookup, and the call
  // is answered by the tool named inside it — by either of the names the
  // bridge accepts, the namespaced one or the vendor's bare one.
  if (/^search_(.+)_tools$/.test(toolName)) return { toolName, args };
  const wrapped = /^call_(.+)_tool$/.exec(toolName);
  if (wrapped) {
    const inner = typeof args?.name === 'string' ? args.name : '';
    const innerArgs = (args?.args ?? {}) as Record<string, unknown>;
    const t = deferredToolOf(catalog, inner, wrapped[1]);
    return t ? { toolName: prefixed(t), args: innerArgs, ...schemaOf(t) } : { toolName, args };
  }

  // An ordinary name is in `tools` — or, once the bridge has unwrapped a
  // collapsed server's call and re-dispatched it as itself, ONLY in the
  // deferred list: the gate is handed the inner name against the catalog the
  // run started with, where that tool was never promoted into `tools`.
  const tool = catalog.tools.find((t) => t.name === toolName) ?? deferredToolOf(catalog, toolName);
  return tool ? { toolName: prefixed(tool), args, ...schemaOf(tool) } : { toolName, args };
}

/** The tool's input schema, when the catalog carries one — the seams that
 *  judge a vendor-hosted call derive its id arguments from it and send them
 *  with the request, because the gateway never enumerated the server. */
function schemaOf(tool: { inputSchema?: unknown }): { inputSchema?: unknown } {
  return tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {};
}

/** A deferred tool by either name the bridge dispatches on. With a server key
 *  (from the wrapper's name) only that server's list is searched, the way the
 *  bridge resolves it; without one, every list. */
function deferredToolOf(
  catalog: { deferredVendorTools?: ReadonlyMap<string, ReadonlyArray<{ name: string; remoteToolName?: string; serverId: string; inputSchema?: unknown }>> },
  wanted: string,
  serverKey?: string,
): { name: string; serverId: string; inputSchema?: unknown } | undefined {
  if (!wanted) return undefined;
  for (const [serverId, tools] of catalog.deferredVendorTools ?? []) {
    if (serverKey !== undefined && serverId.replace(/[^A-Za-z0-9_]/g, '_') !== serverKey) continue;
    const t = tools.find((c) => c.name === wanted || c.remoteToolName === wanted);
    if (t) return t;
  }
  return undefined;
}

/** `mcp__liftoff-tool-gateway__<name>` for our own tools; `mcp__<name>` for a
 *  vendor's, whose `name` already carries its server. */
function prefixed(tool: { name: string; serverId: string }): string {
  return tool.serverId === OWN_GATEWAY_SERVER_ID
    ? `${SDK_MCP_PREFIX}${OWN_GATEWAY_SERVER_ID}__${tool.name}`
    : `${SDK_MCP_PREFIX}${tool.name}`;
}

/** Per-operation seeds a meta-tool carries (see McpToolDefinition.operationClassifications). */
interface OperationClassifications {
  arg: string;
  byOperation: Record<string, string[]>;
}

/**
 * The catalog entry a call is judged against.
 *
 * For an ordinary tool this is resolveCatalogTool. A meta-tool server (omnisend)
 * exposes one tool — `execute` — whose ARGUMENT names the operation, so the
 * entry's own name, categories and effect describe nothing a call does. The
 * enumerator folds that server's per-operation seeds onto the tool; here the
 * call's operation argument selects the seed and the entry is judged as that
 * operation: its categories, the effect they state, and the DESTRUCTIVE marker
 * the level-2 gate keys on. An operation with no seed falls to the write class
 * — an unknown mutation gates, the same rule every other unknown tool follows.
 */
export function resolveGateTool(call: ToolCallRequest, tools: ModelTool[]): ModelTool | undefined {
  const tool = resolveCatalogTool(call.name, tools);
  const ops = (tool as (ModelTool & { operationClassifications?: OperationClassifications }) | undefined)
    ?.operationClassifications;
  if (!tool || !ops) return tool;
  const operation = (call.input as Record<string, unknown> | undefined)?.[ops.arg];
  const categories = typeof operation === 'string' ? ops.byOperation[operation] : undefined;
  if (!categories) {
    return { ...tool, effect: 'write', categories: tool.categories ?? [] };
  }
  const destructive = categories.includes('destructive');
  const description = tool.description ?? '';
  return {
    ...tool,
    categories,
    effect: categories.some((c) => c === 'write' || c === 'destructive' || c === 'outbound') ? 'write' : 'read',
    description: destructive && !description.includes('⚠️ DESTRUCTIVE')
      ? `⚠️ DESTRUCTIVE: ${description}`
      : description,
  };
}

/**
 * Bare action name = the segment after the last `__` dispatch prefix (same
 * normalization `toolActionMatchesNameSet` uses). This is the `actionClass`
 * key the trust ledger is keyed on. Returns the input unchanged when there is
 * no prefix.
 */
export function bareToolActionName(toolName: string): string {
  const sep = toolName.lastIndexOf('__');
  return sep >= 0 ? toolName.slice(sep + 2) : toolName;
}
