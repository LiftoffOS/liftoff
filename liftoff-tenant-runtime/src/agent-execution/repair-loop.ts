// The repair loop: one named failure, one correction, once.
//
// The failure it catches is this estate's dominant defect shape, arriving at
// RUN time instead of review time. An agent is told to do something outward —
// send, post, update, file — and finishes the turn having done everything
// except that. Every layer below it worked. Nothing is in an error state. The
// run is recorded as a success and the thing the person asked for did not
// happen.
//
// For example: an agent reviews a pull request, posts a substantive review,
// and replies nothing; the thread shows the person their own message and
// silence. If nothing anywhere says reporting back is part of the job, nothing
// is missing when it does not happen.
//
// ONE correction, ONCE, and both halves are load-bearing:
//
//   ONE — the reminder NAMES the missing action rather than saying "you did not
//   finish". A model told it failed generically re-runs what it already did;
//   told "you were asked to send and no send happened", it sends.
//
//   ONCE — a loop that retries until the action appears is a loop that spends a
//   tenant's money arguing with a model that has decided not to. If one named
//   correction does not produce it, the honest outcome is a run that reports
//   what it did and did not do.
//
// The reminder is EXCLUDED FROM MEMORY EXTRACTION. It is the host talking to
// the model about a defect in this turn, not a fact about the world or a
// preference the person expressed. Learning from it would teach the agent that
// its operator repeatedly nags it about sending things.

import { logger } from '../infrastructure/logging';

/** Verbs that name an outward action — one that changes something or reaches
 *  somebody outside the conversation. Kept to the imperative forms an
 *  objective is actually written in. */
const OUTWARD_VERBS = [
  'send', 'sends', 'email', 'emails', 'post', 'posts', 'reply', 'replies',
  'notify', 'notifies', 'message', 'create', 'creates', 'update', 'updates',
  'file', 'files', 'submit', 'submits', 'publish', 'publishes', 'comment',
  'comments', 'assign', 'assigns', 'schedule', 'schedules', 'add', 'adds',
  'write', 'writes', 'upload', 'uploads', 'share', 'shares', 'escalate',
] as const;

export interface RepairAssessment {
  /** True when the objective implied an outward action and none happened. */
  needsRepair: boolean;
  /** The verb the objective used, for the reminder's own wording. */
  impliedVerb: string | null;
}

/**
 * Whether this turn owes an outward action it never performed.
 *
 * Both halves are required and neither is sufficient. An objective with no
 * outward verb owes nothing — a research question is complete when it is
 * answered. And a turn that DID call an outward tool has done the thing,
 * whatever else it may have got wrong; this loop is not a quality check.
 *
 * `outwardToolsCalled` is counted from tools the catalog CATEGORISES as write
 * or outbound, never from the tool's name. A name-based test would count
 * `get_updates` as an update and let a read stand in for the send that never
 * happened — which is the same class of mistake as the fence that read
 * uncategorised tools as writes.
 */
export function assessRepair(args: {
  objective: string;
  outwardToolsCalled: number;
  /** Whether the agent had any outward tool at all. Without one there is
   *  nothing to remind it to do, and the reminder would be an instruction to
   *  use a tool it does not have. */
  hasOutwardTool: boolean;
}): RepairAssessment {
  if (!args.hasOutwardTool || args.outwardToolsCalled > 0) {
    return { needsRepair: false, impliedVerb: null };
  }
  const text = (args.objective ?? '').toLowerCase();
  const verb = OUTWARD_VERBS.find((v) => new RegExp(`\\b${v}\\b`).test(text)) ?? null;
  return { needsRepair: verb !== null, impliedVerb: verb };
}

/** Marks the one turn the repair loop injects, so memory extraction can drop
 *  it. A marker rather than a heuristic: extraction must not have to guess
 *  which user turns were really the host. */
export const REPAIR_REMINDER_MARKER = '__liftoff_repair_reminder__';

/**
 * The single correction.
 *
 * Names the action and says what would end the turn, because a generic "you did
 * not finish" makes a model re-narrate what it already did. It also states that
 * this is the only reminder: without that, a model that believes it will be
 * asked again has a reason to defer.
 */
export function buildRepairReminder(verb: string): string {
  return [
    `You were asked to ${verb} something and this turn contains no such action.`,
    '',
    `Do it now with the tool that performs it, or say plainly that you cannot and why.`,
    'This is the only reminder you will get for this run: anything still undone after',
    'this turn is reported as undone.',
  ].join('\n');
}

/** Whether a turn is the host's repair reminder. Read by memory extraction. */
export function isRepairReminder(content: unknown): boolean {
  return typeof content === 'string' && content.includes(REPAIR_REMINDER_MARKER);
}

/** Emit the metric. Separate so the decision and its telemetry cannot drift. */
export function reportRepair(args: {
  fired: boolean;
  verb: string | null;
  tenantId: string;
  agentId: string;
  invocationId?: string;
}): void {
  if (!args.fired) return;
  logger.warn({
    event: 'repair_loop_fired',
    metric: 'repair_loop.fired',
    verb: args.verb,
    tenantId: args.tenantId,
    agentId: args.agentId,
    invocationId: args.invocationId,
  }, 'the objective implied an outward action and the turn performed none; correcting once');
}


/**
 * Whether a tool CHANGES something or reaches somebody.
 *
 * From the catalog's own categories, because that is the one place the answer
 * is recorded rather than guessed. `write` and `outbound` are the two that
 * count: an outbound tool reaches a person, and a write changes a record, and
 * either satisfies "the outward thing happened".
 *
 * A tool the catalog has no categories for is NOT counted. That direction is
 * deliberate — counting an unknown tool as outward would let any call at all
 * satisfy the check, which turns the loop off silently for exactly the agents
 * whose catalogs are least well described.
 */
export function isOutwardTool(
  catalog: { tools: Array<{ name: string; categories?: readonly string[] }> } | undefined,
  toolName: string,
): boolean {
  const tool = catalog?.tools.find((t) => t.name === toolName);
  const cats = (tool?.categories ?? []).map((c) => String(c).toLowerCase());
  return cats.includes('write') || cats.includes('outbound');
}

/** Whether the agent has ANY outward tool. Without one the reminder would be a
 *  demand it cannot satisfy. */
export function hasOutwardTool(
  catalog: { tools: Array<{ name: string; categories?: readonly string[] }> } | undefined,
): boolean {
  return (catalog?.tools ?? []).some((t) => {
    const cats = (t.categories ?? []).map((c) => String(c).toLowerCase());
    return cats.includes('write') || cats.includes('outbound');
  });
}
