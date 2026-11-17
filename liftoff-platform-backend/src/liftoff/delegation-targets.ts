// Who Liftoff can bring into a thread, and the two tools that find them.
//
// The roster is the same one the dashboard composer's mention picker offers, and
// deliberately uses the same vocabulary for the same colleagues, so a mention and
// a delegated message name a colleague identically:
//
//   'caio'      the Chief AI Officer, which designs and changes agents
//   'insights'  the Insights Manager, which answers from real workspace data
//   <uuid>      one of the workspace's own agents (an internal_agents id)
//
// THE ROSTER IS NOT STABLE. Teams are created, renamed, paused and deleted while
// people are mid-conversation, so it is never baked into the system prompt: a
// prompt is written once per turn and would be a snapshot that is wrong the
// moment somebody deletes a team, and it would grow with every team the
// workspace owns. Instead the model LOOKS THEM UP with `list_colleagues`, which
// reads the database at the moment it is called.
//
// Even that is only as fresh as the second it ran in, so resolution never trusts
// it: resolveDelegationTarget re-reads the row when the delegation actually
// fires, and a target that has since been deleted, paused or moved comes back
// unresolved rather than being taken on trust.

import { log } from '../infrastructure/logging';
import { assistantByKind } from '../agent-chat/assistant-targets';
import { internalAgentService } from '../internal-agents/service';
import type { LLMToolDefinition } from '../llm/types';

// ── Names ───────────────────────────────────────────────────────────────

/** Discovery. An ordinary tool: its result goes back to the model. */
export const LIST_COLLEAGUES_TOOL = 'list_colleagues';

/** Delegation. NOT an ordinary tool: when it resolves, the turn is handed over
 *  and Liftoff says nothing further. */
export const BRING_IN_COLLEAGUE_TOOL = 'bring_in_colleague';

/** 'liftoff' is a target only for the other two platform assistants: Liftoff
 *  never brings itself in, so it is not in SYSTEM_TARGETS and cannot resolve
 *  from a Liftoff turn. */
export type DelegationTargetKind = 'liftoff' | 'caio' | 'insights' | 'team';

export interface DelegationTarget {
  kind: DelegationTargetKind;
  /** What the model passes back, and what is written to
   *  liftoff_chat_messages.author: 'caio', 'insights', or the team's id. */
  id: string;
  /** The name a person sees, stored alongside the message so a later rename
   *  does not relabel a reply they have already read. */
  label: string;
  /** One line on what this colleague is for, shown to the model in the
   *  `list_colleagues` result. */
  description: string;
}

/** The Chief AI Officer's identity as it is written into a Liftoff message.
 *
 *  Exported because a late notice, mirrored in from workforce-service after
 *  provisioning finishes, has to be attributed exactly as a reply copied across
 *  during a live turn is. Two spellings of the same colleague would render as
 *  two colleagues. */
export const CAIO_DELEGATION_TARGET: DelegationTarget = {
  kind: 'caio',
  id: 'caio',
  label: assistantByKind('caio')!.name,
  description: assistantByKind('caio')!.description,
};

/** The Insights Manager's identity, exported for the same reason the CAIO's
 *  is: the MCP server offers the same colleagues under the same names, and two
 *  spellings of one colleague would render as two colleagues. */
export const INSIGHTS_DELEGATION_TARGET: DelegationTarget = {
  kind: 'insights',
  id: 'insights',
  label: assistantByKind('insights')!.name,
  description: assistantByKind('insights')!.description,
};

/** Liftoff's identity as a colleague, for when the Chief AI Officer or the
 *  Insights Manager hands a turn to it (agent-chat/handover.ts). Kept out of
 *  SYSTEM_TARGETS below on purpose: that roster is what Liftoff itself offers
 *  the model, and Liftoff bringing in Liftoff is not a thing. */
export const LIFTOFF_DELEGATION_TARGET: DelegationTarget = {
  kind: 'liftoff',
  id: 'liftoff',
  label: assistantByKind('liftoff')!.name,
  description: assistantByKind('liftoff')!.description,
};

/** The two colleagues every workspace has. They are not rows anywhere, so they
 *  are named here rather than looked up. */
const SYSTEM_TARGETS: readonly DelegationTarget[] = [
  CAIO_DELEGATION_TARGET,
  INSIGHTS_DELEGATION_TARGET,
];

// ── Live lookup ─────────────────────────────────────────────────────────

/**
 * Everyone this tenant can delegate to right now.
 *
 * Teams are filtered to `status === 'active'`, matching the mention picker,
 * which asks for active teams only. A draft team has nothing to run yet and a
 * paused one has been deliberately taken out of service, so offering either
 * would be offering something that cannot answer.
 *
 * Soft deletes are handled by listAllByTenant's own `deleted_at IS NULL`
 * predicate, which is the only reason status alone is safe to filter on here.
 */
export async function listDelegationTargets(tenantId: string): Promise<DelegationTarget[]> {
  const targets: DelegationTarget[] = [...SYSTEM_TARGETS];
  try {
    // includeCosts: false skips a 30-day cost rollup this never reads.
    const teams = await internalAgentService.listAllByTenant(tenantId, { includeCosts: false });
    for (const team of teams) {
      if (team.status !== 'active') continue;
      targets.push({
        kind: 'team',
        id: team.id,
        label: team.role,
        description: team.summary?.trim() || team.responsibilities?.trim() || 'An agent in this workspace.',
      });
    }
  } catch (err) {
    // The two system colleagues are still reachable, so a failed team lookup
    // degrades the roster rather than the turn.
    log.error(
      { tenantId, error: (err as Error).message },
      'Liftoff could not list the tenant agents for delegation',
    );
  }
  return targets;
}

/**
 * Resolve what the model asked for, at the moment it asks for it.
 *
 * Called when the delegation fires, NOT when the roster was listed. A team can
 * be deleted or paused between the two, and a stale id must not send a person's
 * request into a thread nobody owns. Returns null for anything that does not
 * resolve, which the caller turns into a tool result the model can recover from.
 *
 * getById carries the two predicates that matter in its own SQL,
 * `tenant_id = $2 AND deleted_at IS NULL`, so a team from another tenant and a
 * soft-deleted team both come back as null rather than as a row with the wrong
 * status. `status === 'active'` is then checked here, because that table
 * soft-deletes and status on its own would happily return a deleted row.
 */
export async function resolveDelegationTarget(
  tenantId: string,
  targetId: string,
): Promise<DelegationTarget | null> {
  const trimmed = targetId.trim();
  if (!trimmed) return null;

  const system = SYSTEM_TARGETS.find((target) => target.id === trimmed);
  if (system) return system;

  try {
    const team = await internalAgentService.getById(trimmed, tenantId);
    if (!team) return null;
    if (team.status !== 'active') return null;
    return {
      kind: 'team',
      id: team.id,
      label: team.role,
      description: team.summary?.trim() || team.responsibilities?.trim() || 'An agent in this workspace.',
    };
  } catch (err) {
    // A malformed id reaches the database as a bad uuid cast. That is the model
    // guessing, not a fault, so it resolves to nothing like any other miss.
    log.warn(
      { tenantId, targetId: trimmed, error: (err as Error).message },
      'Liftoff could not resolve a delegation target',
    );
    return null;
  }
}

// ── Tools ───────────────────────────────────────────────────────────────

/**
 * Discovery, and an ordinary tool in every respect: the model calls it, reads
 * the result and carries on. It exists because the roster is live and cannot be
 * written into a prompt.
 */
export const listColleaguesTool: LLMToolDefinition = {
  name: LIST_COLLEAGUES_TOOL,
  description:
    'List the colleagues you can bring into this conversation right now: the Chief AI Officer, '
    + 'the Insights Manager, and every active agent in this workspace. '
    + 'Call this before bringing in an agent, because agents are created, renamed, paused and '
    + 'deleted continuously and you cannot know from memory which ones exist. '
    + 'You do not need it for the Chief AI Officer or the Insights Manager, which are always available.',
  input_schema: { type: 'object', properties: {} },
};

/**
 * Delegation, and NOT an ordinary tool. When the target resolves, nothing comes
 * back for Liftoff to paraphrase: the colleague takes the rest of the reply and
 * Liftoff says nothing further. The description says so plainly, because a model
 * that expects a result writes a preamble and then a summary, and the person
 * reads the same answer twice in two voices.
 *
 * The one case that DOES come back is a target that no longer resolves. That
 * returns an ordinary tool result naming what does exist, so the model can say
 * what happened and offer the alternative rather than the turn dying.
 *
 * `target` is a free string rather than an enum, deliberately: an enum would
 * have to be built per request from a roster that is already stale by the time
 * the model answers, and it would put every team id in every prompt.
 */
export const bringInColleagueTool: LLMToolDefinition = {
  name: BRING_IN_COLLEAGUE_TOOL,
  description:
    'Bring a colleague into this conversation to do the work here. Use it for anything about '
    + 'designing, creating or changing an agent (the Chief AI Officer), for analytics from real '
    + 'workspace data (the Insights Manager), or to put a question to one of the workspace agents. '
    + 'The colleague joins this conversation: the person is not sent anywhere. '
    + 'Calling this hands the rest of the reply over, so you will not get a result back. Do not '
    + 'announce it, do not describe what will happen, and do not write anything before or after '
    + 'the call.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description:
          "Who to bring in: 'caio' for the Chief AI Officer, 'insights' for the Insights Manager, "
          + `or an agent's id exactly as ${LIST_COLLEAGUES_TOOL} returned it. Never guess an id.`,
      },
      task: {
        type: 'string',
        description:
          'A brief for the colleague, one or two sentences in your own words, never shown to the '
          + 'person: what they want done, and anything from earlier in this conversation the '
          + 'colleague would otherwise not know, because it does not see this thread. When it is '
          + 'about one existing agent, name it and give its id, so the colleague acts on '
          + 'the right one when two share a name. One exception can see it: when the person '
          + 'wants work that was already done in this conversation to keep happening, however '
          + 'they phrase it, say exactly that here. The Chief AI Officer can read this '
          + 'conversation once told the work already happened in it, so name the fact rather '
          + 'than retelling the work.',
      },
    },
    required: ['target', 'task'],
  },
};

/** What `list_colleagues` hands back to the model, and what an unresolved
 *  delegation hands back so it can recover in the same shape: the roster always
 *  travels with the error, so the model can say what is gone and offer what is
 *  there in one turn. Ids are given because the model needs them to delegate;
 *  the prompt is what forbids showing them to a person. */
export function describeTargetsForModel(
  targets: readonly DelegationTarget[],
  options: { error?: string } = {},
): string {
  return JSON.stringify({
    ...(options.error ? { error: options.error } : {}),
    colleagues: targets.map((target) => ({
      id: target.id,
      name: target.label,
      kind: target.kind,
      whatItDoes: target.description,
    })),
  });
}
