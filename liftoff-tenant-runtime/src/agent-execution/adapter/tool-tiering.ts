// Collapsing an oversized vendor MCP server behind a search pair.
//
// A SINGLE vendor MCP server can supply dozens of an agent's tools, and a large
// share of its schema characters. Every one of
// those schemas is paid on every model call for the life of the run, whether
// the agent touches that server or not.
//
// So a server past the cap stops contributing its tools directly and
// contributes two instead:
//
//   search_<server>_tools(query)     — find the right tool by description
//   call_<server>_tool(name, args)   — call it once found
//
// Two rules make this safe rather than merely smaller:
//
//   * A tool the agent's own instructions NAME is never collapsed. Distilled
//     prompts and skills talk about `file_read` and `shell_exec` by name, and
//     deferring those breaks the prompt's own vocabulary. Everything collapsible
//     is named explicitly rather than by exclusion, so adding a tool cannot
//     silently defer something the prompts depend on.
//   * The catalog is still assembled statelessly per invocation. Nothing is
//     remembered between runs, so the drift failure Hermes hit — a cached
//     catalog going stale against a server that changed — cannot happen here.
//
// WHICH ENGINES THIS IS FOR, and what happens on the one it is not.
//
// Tiering rewrites `catalog.tools` and nothing else, so it applies to every
// engine that builds the model's tool surface from that list: openai and
// openrouter through mcp-bridge, gemini and google-adk as function declarations,
// codex and opencode over `exposeCatalogOverHttp`. `claude-agent-sdk` is handed
// `catalog.servers` instead — the live in-process McpServer and the vendor
// servers by URL — and never reads it. An agent on that engine whose server
// this records as collapsed keeps calling that server's tools by name, and
// the search/call pair goes unused.
//
// THAT IS NOT A LEAK, because the SDK does this itself. Tool search is on by
// default in the Agent SDK; it withholds tool definitions and loads only what a
// turn needs (`defer_loading` on the API, `ENABLE_TOOL_SEARCH` to tune the
// threshold, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` to kill it); see the note
// on `report_task_outcome` in tool-gateway/mcp-server.ts. So the schemas are not
// paid in full on that engine; the vendor was already doing what this
// module does.
//
// WHAT WAS ACTUALLY MISSING is the other half of the contract. Rule one above —
// a tool the agent's own instructions NAME is never hidden — was enforced only
// here, on the engines that read `catalog.tools`, while the SDK deferred the
// same vocabulary on its own engine with nothing opting it out.
// The browser-navigation rules hoisted above the persona block in
// interactive-chat/system-prompt.ts are the scar from that: prose patching a
// mechanism that was available and unused. `isAlwaysLoadedTool` below is now
// read at both call sites, so one vocabulary drives our collapse and the SDK's
// `alwaysLoad`, and neither can hide a tool the prompts depend on.
//
// THE SANDBOX CATALOG IS THE SECOND HALF OF THE PROBLEM, and it is larger than
// the vendor one. Measured over `filterSandboxFunctionsByCapabilities(['shell',
// 'file', 'browser', 'vscode'])` — what EVERY execution_enabled agent gets,
// because the tier is binary and nothing trims it — the catalog is 90 tools:
//
//   browser_*  43   proxy_*  11   shell_*  11   file_*  11   bash_*  4
//   nodejs_*    3   git_*     2   code_*    2   content_*  1  util_*  1  vscode_*  1
//
// The cost argument is the smaller one. The BEHAVIOURAL argument is stronger:
// interactive-chat/system-prompt.ts documents that hard tool-selection rules had
// to be hoisted ABOVE the persona block because "with the full preamble in
// place, cold-start 'Navigate to <URL>' still tripped ToolSearch → WebFetch on a
// persona-distilled agent", and `web_research` was "declined as out of scope".
// A narrow persona plus a large catalog produces refusals of in-scope work.

import type { DeferredVendorTool, McpToolDefinition } from './catalog-types';
import { STEP_OUTPUT_TOOL } from '../terminal-state';

/** Tools from one server past which it is cheaper to search than to list.
 *
 *  25 is above what a well-behaved integration exposes and well below a
 *  pathological single-server catalog, so a normal server is untouched and the
 *  pathological one is caught. */
export const DEFAULT_SERVER_TOOL_CAP = Number(process.env.MCP_SERVER_TOOL_CAP ?? 25);

/** A tool the model can no longer see directly, kept so the search pair can
 *  resolve it — with the classification fields every seam past the model reads
 *  off it (see DeferredVendorTool). */
export type DeferredTool = DeferredVendorTool;

export interface TieringResult {
  /** What the model sees. */
  tools: McpToolDefinition[];
  /** Everything collapsed, by group key, for the search pair to resolve. */
  deferred: Map<string, DeferredTool[]>;
  /** Group keys that were collapsed, for telemetry. */
  collapsedServers: string[];
}

/** A named set of tools that collapses together behind one search/call pair.
 *
 *  Generalized from the original vendor-server-only shape so the SANDBOX
 *  catalog can be tiered by the same machinery. A vendor server is still a
 *  group — one auto-derived per serverId, byte for byte what it produced
 *  before — and the sandbox families are additional groups alongside it. */
export interface TieringGroup {
  /** Stable identifier, used to build the search/call tool names. */
  key: string;
  /** Human phrase for the search/call tool descriptions ("browser control"). */
  label: string;
  match: (t: McpToolDefinition) => boolean;
  /** Collapse once the group contributes more than this many tools. */
  cap: number;
}

function searchToolName(key: string): string {
  return `search_${key.replace(/[^A-Za-z0-9_]/g, '_')}_tools`;
}

function callToolName(key: string): string {
  return `call_${key.replace(/[^A-Za-z0-9_]/g, '_')}_tool`;
}

/** One auto-derived group per vendor server id.
 *
 *  Exactly today's behaviour, expressed in the new shape: the predicate decides
 *  eligibility, each server becomes its own group, and everything else passes
 *  through untouched — which is what keeps core, connector and named sandbox
 *  tools always visible. */
export function vendorServerGroups(
  tools: McpToolDefinition[],
  isVendorTool: (t: McpToolDefinition) => boolean,
  cap: number = DEFAULT_SERVER_TOOL_CAP,
): TieringGroup[] {
  const serverIds = new Set<string>();
  for (const t of tools) if (isVendorTool(t)) serverIds.add(t.serverId);
  return [...serverIds].map((serverId) => ({
    key: serverId,
    label: `${serverId} integration`,
    match: (t: McpToolDefinition) => isVendorTool(t) && t.serverId === serverId,
    cap,
  }));
}

/** One group per CUSTOM API CONNECTION.
 *
 *  Connecting a custom API is connecting the API: every operation the
 *  specification describes becomes available, up to two hundred of them. The
 *  existing collapse cannot reach them — `vendorServerGroups` is handed a
 *  predicate over `kind: 'remote'` servers (vendor-hosted MCP plus
 *  `custom_mcp_server`), and these are in-process connector tools on the
 *  gateway's own server — so without a group of their own one workspace's two
 *  hundred schemas are paid on every model call of every run.
 *
 *  Grouped BY CONNECTOR ID, which is what the alias carries: several tenants
 *  share a runtime process, and two workspaces could both choose the same
 *  provider slug. The connector UUID is unique across tenants; a slug is not.
 */
export function customApiConnectorGroups(
  aliases: readonly string[],
  cap: number = DEFAULT_SERVER_TOOL_CAP,
): TieringGroup[] {
  return [...new Set(aliases)].map((alias) => ({
    key: alias,
    label: `the ${alias} API connection`,
    // The alias prefix is the whole membership test: the gateway composes every
    // one of a connection's operations as `<alias>__<operation>`.
    match: (t: McpToolDefinition) => t.name.startsWith(`${alias}__`),
    cap,
  }));
}

/**
 * Collapse any group contributing more than its cap.
 *
 * Groups are tried IN ORDER and a tool belongs to the first one that matches, so
 * a more specific group can precede a broader one without the two fighting over
 * the same tool.
 */
export function applyToolTiering(
  tools: McpToolDefinition[],
  groups: TieringGroup[],
  vendorCap: number = DEFAULT_SERVER_TOOL_CAP,
  /** Names this RUN may not collapse, on top of the static vocabulary.
   *
   *  `isAlwaysLoadedTool` is a static list and does not read prompts, so
   *  nothing protected an operation a distilled workflow names BY NAME — and a
   *  workflow step whose tool has to be searched for first is a step whose
   *  contract depends on the model running a search. Computed per run from the
   *  steps (`workflowNamedToolNames`) and passed in here. */
  alwaysLoaded: ReadonlySet<string> = new Set(),
): TieringResult {
  const deferred = new Map<string, DeferredTool[]>();
  const collapsedServers: string[] = [];

  if (!Number.isFinite(vendorCap) || vendorCap <= 0) {
    return { tools, deferred, collapsedServers };
  }

  const groupFor = (t: McpToolDefinition): TieringGroup | undefined =>
    groups.find((g) => g.match(t));

  // Count per group.
  const perGroup = new Map<string, number>();
  for (const t of tools) {
    const g = groupFor(t);
    if (!g) continue;
    perGroup.set(g.key, (perGroup.get(g.key) ?? 0) + 1);
  }
  const over = new Set(
    groups
      .filter((g) => {
        const cap = Number.isFinite(g.cap) && g.cap > 0 ? g.cap : vendorCap;
        return (perGroup.get(g.key) ?? 0) > cap;
      })
      .map((g) => g.key),
  );
  if (over.size === 0) return { tools, deferred, collapsedServers };

  const kept: McpToolDefinition[] = [];
  for (const t of tools) {
    const g = groupFor(t);
    if (!g || !over.has(g.key)) {
      kept.push(t);
      continue;
    }
    // Rule one, enforced centrally: a tool the run's own instructions name is
    // never collapsed. The static vocabulary is read here as well as at the
    // SDK's registration, so one list drives both mechanisms and neither can
    // hide a tool the prompts depend on.
    if (alwaysLoaded.has(t.name) || isAlwaysLoadedTool(t.name)) {
      kept.push(t);
      continue;
    }
    const list = deferred.get(g.key) ?? [];
    list.push({
      name: t.name,
      remoteToolName: t.remoteToolName,
      description: t.description,
      inputSchema: t.inputSchema,
      serverId: t.serverId,
      // Carried, not dropped: what this tool DOES is the same question whether
      // the model reached it by name or through the search pair.
      categories: t.categories,
      draftVariant: t.draftVariant,
      effect: t.effect,
      workRole: t.workRole,
      writeRole: t.writeRole,
      operationClassifications: t.operationClassifications,
    });
    deferred.set(g.key, list);
  }

  for (const group of groups) {
    if (!over.has(group.key)) continue;
    const count = deferred.get(group.key)?.length ?? 0;
    // Every tool in this group was protected, so nothing was deferred. A pair
    // offering zero tools is two schemas the model pays for and can never use,
    // and a search that answers nothing reads as a broken integration rather
    // than as a group that did not need collapsing.
    if (count === 0) continue;
    collapsedServers.push(group.key);
    // The synthetic pair is attributed to the serverId the group's own tools
    // came from, so a downstream consumer that routes by serverId still can.
    const serverId = deferred.get(group.key)?.[0]?.serverId ?? group.key;
    kept.push(
      {
        name: searchToolName(group.key),
        description:
          `Find a tool for ${group.label}. It offers ${count} tools, too many to list here, `
          + 'so search by what you are trying to do and this returns the matching tool names with their inputs. '
          + `Then call it with ${callToolName(group.key)}.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are trying to do, in plain words.' },
          },
          required: ['query'],
        },
        serverId,
      } as McpToolDefinition,
      {
        name: callToolName(group.key),
        description:
          `Call a tool for ${group.label} by name. `
          + `Use ${searchToolName(group.key)} first to find the name and its inputs.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name, exactly as search returned it.' },
            args: { type: 'object', description: 'Arguments for that tool.' },
          },
          required: ['name'],
        },
        serverId,
      } as McpToolDefinition,
    );
  }

  return { tools: kept, deferred, collapsedServers };
}

/** Tools that are NEVER collapsed, whatever group they would fall into.
 *
 *  Distilled prompts and skills name these by vocabulary, so deferring one
 *  breaks the prompt's own language: an agent told to "read the file, then run
 *  the tests" cannot follow that instruction if `file_read` and `shell_exec`
 *  have to be searched for first.
 *
 *  `code_session` is the correction that makes this list load-bearing rather
 *  than decorative. It is tagged `source: 'sandbox'` at mcp-server.ts, so a
 *  naive source-based predicate would collapse the PRIMARY code-work entry point
 *  on the Anthropic path. It is not in function-registry.ts — it is pushed
 *  separately — so nothing else would have caught it. */
export const NEVER_COLLAPSE_SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  'shell_exec',
  'file_read', 'file_write', 'file_edit', 'file_search', 'file_grep',
  'file_glob', 'file_find', 'file_str_replace_editor',
  'git_clone', 'git_commit_and_push',
  'code_execute', 'code_get_info',
  'util_convert_to_markdown',
  'bash_session_create', 'bash_session_exec',
  'code_session',
]);

/**
 * Tools no disclosure mechanism may hide, ours or the vendor's.
 *
 * `NEVER_COLLAPSE_SANDBOX_TOOLS` is the vocabulary; this is the decision applied
 * to it, and it is exported so the two places that act on it cannot drift. Our
 * tiering reads it on the engines that consume `catalog.tools`; the Claude Agent
 * SDK gets the same answer as `alwaysLoad` on the tool registration, because it
 * defers large MCP catalogs behind its own tool search by default. Before that
 * second call site existed, the vocabulary was protected on the engines that
 * read `catalog.tools` and unprotected on the SDK engine.
 *
 * `report_task_outcome` is here rather than only at its registration for the same
 * reason: a terminal contract that depends on the model running a ToolSearch
 * first is a terminal contract that can be missed.
 *
 * `record_step_output` is here on identical reasoning. It carries a workflow
 * step's declared `outputField` back to the next step, and a step that does not
 * call it fails its output contract — so letting the SDK defer it would make
 * the contract depend on the model running a ToolSearch first, which is the
 * exact failure this function exists to prevent.
 *
 * `propose_routine` and `run_routine_now` are here because the chat system
 * prompt names them BY NAME as the only way to start, change, stop, or run
 * the agent's schedule. A prompt contract that depends on the model running a
 * ToolSearch first is the same missable contract: deferred, the model
 * searched "scheduling tools", found the in-session wake machinery, reasoned
 * correctly about the wrong tools, and told the person to go edit a cron in
 * their settings — the one outcome the routine rails exist to prevent.
 */
export function isAlwaysLoadedTool(name: string): boolean {
  return NEVER_COLLAPSE_SANDBOX_TOOLS.has(name)
    || name === 'report_task_outcome'
    || name === STEP_OUTPUT_TOOL
    || name === 'propose_routine'
    || name === 'bring_in_colleague'
    || name === 'run_routine_now';
}

/**
 * The catalog names this run's workflow steps depend on.
 *
 * `isAlwaysLoadedTool` above is a STATIC list — the sandbox vocabulary, the
 * terminal contract and the step-output tool — and it does not read prompts. So
 * nothing protected an operation a distilled workflow names by name, which is
 * exactly the tool a run cannot do without: a `tool_call` step whose tool is
 * behind a search pair is a step whose contract depends on the model running a
 * search first, which is the failure the never-collapse rule exists to prevent.
 *
 * A step's authored name may not be the catalog's, so both are returned: the
 * authored spelling and, where the catalog has a tool whose name ends in it
 * after the `__` alias separator, that tool's full name.
 */
export function workflowNamedToolNames(
  steps: ReadonlyArray<{ toolName?: string | null }> | undefined,
  tools: ReadonlyArray<{ name: string }>,
): Set<string> {
  const out = new Set<string>();
  if (!steps || steps.length === 0) return out;
  for (const step of steps) {
    const authored = (step?.toolName ?? '').trim();
    if (!authored) continue;
    out.add(authored);
    // Both spellings, because the two mechanisms that read this set see
    // different ones: our collapse works on the composed `<alias>__<tool>`
    // name, and the gateway's registration knows the bare function name as
    // well. A set carrying only one of them protects only one of the two.
    const bare = authored.includes('__') ? authored.split('__').slice(1).join('__') : authored;
    out.add(bare);
    for (const t of tools) {
      if (t.name === authored) continue;
      const tBare = t.name.includes('__') ? t.name.split('__').slice(1).join('__') : t.name;
      if (tBare === bare) out.add(t.name);
    }
  }
  return out;
}

/** Which sandbox families collapse, and under what label.
 *
 *  Named explicitly rather than derived by exclusion: a family added to the
 *  registry later must be considered deliberately, not swept into a search pair
 *  because nobody listed it. `cap: 1` because a family worth grouping is worth
 *  collapsing as soon as it has more than one collapsible member — the pair
 *  costs roughly two schemas, so anything above two members already pays.
 *
 *  Absent by design: `git_*`, `code_*` and `util_*` (every member is in the
 *  never-collapse set) and `content_*` (one tool, and it is the file-search
 *  companion the prompts reach for). */
const SANDBOX_GROUP_SPECS: ReadonlyArray<{ key: string; label: string; prefixes: string[] }> = [
  // Named for what it IS, not what it does. "browser control" is what a model
  // looking for a browser matches, and this family is the HEADLESS one inside
  // the sandbox: driving it leaves the user-visible pane blank.
  {
    key: 'sandbox_browser',
    label: 'headless browser automation inside the sandbox, which the user cannot see',
    prefixes: ['browser_'],
  },
  { key: 'sandbox_proxy', label: 'proxy and network capture', prefixes: ['proxy_'] },
  { key: 'sandbox_shell', label: 'shell session management', prefixes: ['shell_', 'bash_'] },
  { key: 'sandbox_file', label: 'file management', prefixes: ['file_'] },
  { key: 'sandbox_nodejs', label: 'Node.js session management', prefixes: ['nodejs_'] },
  { key: 'sandbox_vscode', label: 'VS Code integration', prefixes: ['vscode_'] },
];

/** True when a tool comes from the sandbox function registry.
 *
 *  Read from the catalog's own `source` tag rather than re-derived from the
 *  name, so a rename cannot quietly move a tool out of scope. */
function isSandboxTool(t: McpToolDefinition): boolean {
  return (t as { source?: string }).source === 'sandbox';
}

/** The sandbox tiering groups. */
export function sandboxGroups(): TieringGroup[] {
  return SANDBOX_GROUP_SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    cap: 1,
    match: (t: McpToolDefinition) =>
      isSandboxTool(t)
      && !NEVER_COLLAPSE_SANDBOX_TOOLS.has(t.name)
      && spec.prefixes.some((p) => t.name.startsWith(p)),
  }));
}

/** Is this one of the two tools a collapsed server contributes? */
export function parseTieredToolName(
  name: string,
): { kind: 'search' | 'call'; serverKey: string } | null {
  const s = /^search_(.+)_tools$/.exec(name);
  if (s) return { kind: 'search', serverKey: s[1] };
  const c = /^call_(.+)_tool$/.exec(name);
  if (c) return { kind: 'call', serverKey: c[1] };
  return null;
}

/**
 * Rank deferred tools against a plain-language query.
 *
 * Deliberately lexical rather than embedding-backed: this runs inside a tool
 * call the model is waiting on, the corpus is a few dozen short descriptions,
 * and an embedding round-trip would cost more than the tokens it saves.
 */
export function searchDeferredTools(
  candidates: DeferredTool[],
  query: string,
  limit = 8,
): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (terms.length === 0) {
    return candidates.slice(0, limit).map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
    }));
  }

  const scored = candidates.map((t) => {
    const haystack = `${t.name} ${t.description ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 1;
      // A name match is worth more than a description match: the model is
      // usually reaching for something it half-remembers the name of.
      if (t.name.toLowerCase().includes(term)) score += 2;
    }
    return { t, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ t }) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
