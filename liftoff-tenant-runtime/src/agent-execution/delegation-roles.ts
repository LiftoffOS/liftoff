// What a run at the bottom of a delegation tree is allowed to do.
//
// Depth, fan-out and concurrency caps already exist, and they bound the SHAPE
// of a tree. They say nothing about what a run does once it is in one, and that
// is where the expensive failures live: a child spawned to "check the tests"
// spawns its own children, each of which schedules a follow-up, and a task that
// should have been one run becomes a tree nobody asked for and nobody is
// watching. The depth cap eventually stops it, but only after the spend.
//
// So every run has a ROLE:
//
//   * ORCHESTRATOR — may delegate, may schedule, may wake. It is coordinating.
//   * LEAF — does the work and returns. It cannot delegate, cannot schedule
//     itself, cannot suspend waiting for something. Its whole job is to finish.
//
// A run is a leaf when spawning again would exceed the depth cap. That is
// deliberate: the alternative is discovering the cap at dispatch time, which
// means the model spent a turn writing a delegation that was always going to be
// refused, read an error, and had to recover from it. A leaf simply never sees
// the tools, so there is nothing to attempt.
//
// The leaf also carries a tighter iteration budget than its parent. A child
// exists to answer one question; a child that has taken fifty turns is not
// converging, and the parent — which IS still watching — should get the failure
// rather than an invoice.
//
// Enforced in two places on purpose. Hiding the tools stops the model reaching
// for them; the dispatch check stops a stale catalog, a resumed session, or a
// replayed tool call from getting through anyway. Neither alone is enough: the
// first is not a control, and the second alone wastes a turn every time.

import { DELEGATION_DEFAULTS } from './delegation-defaults';

/**
 * Fallback depth cap, used only when the tenant's own cap could not be read.
 *
 * The real boundary is the TENANT's effective cap — `resolveDelegationRoleFor`
 * below — because a tenant that configured a deeper tree would otherwise have
 * its middle layer marked leaf and stripped of the tools it is entitled to.
 *
 * Read from the setting that actually caps delegation, never a constant of its
 * own. A separate number turns this into dead code: if it says 2 while the real
 * cap says 1, no invocation ever reaches the leaf depth and the whole role
 * model is unreachable. Two numbers that have to agree will not.
 */
export const MAX_ORCHESTRATION_DEPTH = DELEGATION_DEFAULTS.MAX_DEPTH;

// Per-parent CONCURRENCY is deliberately not set here.
//
// The obvious move was a second cap layered on the tenant gate. It is the wrong
// one twice over. It would have cut effective fan-out for every existing tenant
// from their configured value to a number this module invented — a silent
// regression for people who never asked for it. And concurrency already HAS an
// owner: `loadDispatchGate` reads the per-tenant setting, clamps it to a hard
// cap, and reports when a tenant's value was clamped. A second control in a
// second place is how two numbers that must agree stop agreeing.
//
// A deployment that wants tighter fan-out sets the value that already exists
// (`DEFAULT_MAX_CONCURRENT_CHILDREN`, or the per-tenant runtime config). What
// this module adds is the ROLE — which is orthogonal, and which nothing else
// was doing.

/** Turns a child gets. A child answering one question in fifty turns is not
 *  converging, and its parent is still there to be told so. */
export const CHILD_ITERATION_BUDGET = Number(process.env.CHILD_ITERATION_BUDGET ?? 50);

export type DelegationRole = 'orchestrator' | 'leaf';

/** Tools a leaf does not get. Everything here either starts more work or
 *  suspends this run waiting for work — both are coordination, and a leaf is
 *  not coordinating. */
export const ORCHESTRATION_ONLY_TOOLS: readonly string[] = [
  'spawn_task_graph',
  // Found by the completeness fitness test on its first run: registered with
  // effect: 'spawn' and absent from this list, so a leaf stripped of every
  // other way to start work kept this one. The list is hand-maintained; the
  // test derives what must be here from the gateway's own declarations.
  'spawn_child_task',
  'delegate_to_agent',
  // The governed fan-out tool. It was missing from this list, so stripping
  // delegate_to_agent from a leaf left it the tool that delegates to SEVERAL
  // agents at once — a wider hole than the one being closed.
  'delegate_task',
  'schedule_followup',
  'sleep_until',
  'wake_on_event',
  'wake_on_job',
  'wake_on_poll',
  'wake_on_any',
  'wake_on_all',
];

const ORCHESTRATION_TOOL_SET = new Set(ORCHESTRATION_ONLY_TOOLS);

/** The per-teammate delegation tools the gateway registers, one per active
 *  agent: `internal__<alias>__execute`, or `internal__<alias>__<id8>__execute`
 *  when two teammates share an alias.
 *
 *  These need their own test because reducing a namespaced name to its last
 *  segment turns `internal__code_reviewer__execute` into `execute`, which is not
 *  in the set above — so every one of them sailed through a filter that had just
 *  removed `delegate_to_agent`. A leaf stripped of the generic delegation tool
 *  kept a bespoke delegation tool for each of its teammates, which is not a
 *  boundary at all. */
const PER_TEAMMATE_DELEGATION_TOOL = /(^|__)internal__.+__execute$/i;

export function isOrchestrationOnlyTool(name: string): boolean {
  if (PER_TEAMMATE_DELEGATION_TOOL.test(name)) return true;
  // Model-facing names are namespaced per MCP server; reduce to the bare name
  // so one list covers every engine's spelling.
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return ORCHESTRATION_TOOL_SET.has(bare.toLowerCase());
}

/**
 * Which role this run has.
 *
 * A run at or past the depth limit is a leaf by construction — not because
 * somebody configured it that way, but because a child of it would exceed the
 * cap and be refused anyway. Depth 0 is the run a person or a schedule started.
 */
export function resolveDelegationRole(
  delegationDepth: number | null | undefined,
  maxDepth: number = MAX_ORCHESTRATION_DEPTH,
): DelegationRole {
  const depth = delegationDepth ?? 0;
  return depth >= maxDepth ? 'leaf' : 'orchestrator';
}

/**
 * Which role this run has, under THIS tenant's configured cap.
 *
 * The cap is per-tenant and clamped (`loadDispatchGate`), so a tenant who
 * raised theirs has a middle layer that may legitimately delegate. Deciding the
 * role from the in-code default would strip that layer of its tools while the
 * dispatch gate happily allowed the call — the tools would be missing and
 * nothing would explain why.
 *
 * The config read behind this is cached per tenant, so it is one query per
 * process rather than one per catalog build. A failure falls back to the
 * in-code default, which is the restrictive direction: a run wrongly treated as
 * a leaf loses tools it could have used, while one wrongly treated as an
 * orchestrator would be allowed to build a tree the cap exists to prevent.
 */
export async function resolveDelegationRoleFor(
  tenantId: string,
  delegationDepth: number | null | undefined,
): Promise<DelegationRole> {
  let maxDepth = MAX_ORCHESTRATION_DEPTH;
  try {
    const { loadDispatchGate } = await import('./governed-dispatch');
    maxDepth = (await loadDispatchGate(tenantId)).maxDepth;
  } catch {
    /* fall back to the in-code default — the restrictive direction */
  }
  return resolveDelegationRole(delegationDepth, maxDepth);
}

/** Turn budget for a run in this role. A leaf gets the tighter one; an
 *  orchestrator keeps whatever the caller computed. */
export function iterationBudgetFor(role: DelegationRole, parentBudget: number): number {
  return role === 'leaf' ? Math.min(parentBudget, CHILD_ITERATION_BUDGET) : parentBudget;
}

/** Drop the orchestration tools from a catalog for a leaf. Returns the list
 *  unchanged for an orchestrator, so the common case allocates nothing. */
export function filterToolsForRole<T extends { name: string }>(
  tools: T[],
  role: DelegationRole,
): { tools: T[]; removed: string[] } {
  if (role === 'orchestrator') return { tools, removed: [] };
  const removed: string[] = [];
  const kept = tools.filter((t) => {
    if (!isOrchestrationOnlyTool(t.name)) return true;
    removed.push(t.name);
    return false;
  });
  return { tools: kept, removed };
}

export class LeafDelegationError extends Error {
  readonly code = 'leaf_may_not_delegate';
  constructor(toolName: string) {
    super(
      `This run cannot use ${toolName}: it is a child task, and a child task does the work `
      + 'rather than handing it on. Complete what you were asked and report the result.',
    );
    this.name = 'LeafDelegationError';
  }
}

/**
 * Refuse an orchestration tool from a leaf.
 *
 * The dispatch-time half of the pair. It exists for the cases where hiding the
 * tool is not enough: a resumed session whose catalog was assembled under a
 * different role, a replayed tool call, an engine that caches its tool list.
 *
 * The message is written to the model rather than to a log, because the model
 * is what reads it, and "you cannot do this, do the work instead" is a usable
 * instruction where a bare error code is not.
 */
export function assertToolAllowedForRole(toolName: string, role: DelegationRole): void {
  if (role === 'leaf' && isOrchestrationOnlyTool(toolName)) {
    throw new LeafDelegationError(toolName);
  }
}
