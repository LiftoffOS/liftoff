// Who should answer this Slack message?
//
// The answer was previously two lines inline in the event handler: try the
// thread binding, fall back to the channel one. That is a specificity ladder
// with the bottom rung missing, and the missing rung is the one people feel —
// a workspace that talks almost entirely to one team member is asked to choose,
// again, in every new conversation.
//
// So the ladder is stated once, here, most-specific first:
//
//   1. ADDRESSED    — "Code Reviewer: take a look". Names someone for this one
//                     message and changes no binding, the way you turn to a
//                     particular person mid-conversation.
//   2. THREAD       — this thread already belongs to someone.
//   3. CHANNEL      — this channel or DM has a standing owner.
//   4. WORKSPACE    — the workspace default, for when nothing else applies.
//   5. SUGGESTED    — the team whose role the message plainly calls for, one
//                     selection request over the active roster (Phase 9,
//                     route-suggestion.ts). Consulted only when the four rungs
//                     above are empty; below it is the picker. The four above
//                     are lookups of what a person said; this is the one rung
//                     that judges, and it is the fallback, never a choice.
//
// Two rules keep the bottom rungs from changing what the bot talks in:
//
//   * It is a fallback for WHO, never a reason to speak. A channel where the
//     bot was not addressed stays silent whether or not a default exists —
//     that decision is made before this is consulted, and this returns the
//     same "nobody" it always did for un-addressed traffic.
//   * It never becomes a binding. Answering from the default leaves the
//     conversation unbound, so choosing someone explicitly later is still a
//     first choice rather than a correction.

export type RoutingRung = 'addressed' | 'thread' | 'channel' | 'workspace_default' | 'suggested';

export interface RoutingDecision {
  agentId: string | null;
  /** Which rung answered. Null when nothing did, and the picker is the answer. */
  rung: RoutingRung | null;
  /** True when a THREAD binding matched. The caller needs this separately from
   *  the rung: a reply inside a thread the bot owns is one of the things that
   *  makes it allowed to speak in a channel, and that is about the thread
   *  specifically, not about having found some agent. */
  threadBound: boolean;
}

export interface RoutingLookups {
  /** The addressed-by-name agent for this message, if any. */
  addressedAgentId: string | null;
  /** Binding for this exact thread. */
  threadAgentId: string | null;
  /** Binding for the channel or DM. */
  channelAgentId: string | null;
  /** The workspace's default team member. */
  workspaceDefaultAgentId: string | null;
  /** The suggested answerer (route-suggestion.ts), computed lazily by the
   *  caller only when the four rungs above came up empty. Absent means the
   *  caller did not ask, which reads the same as "nobody suggested". */
  suggestedAgentId?: string | null;
}

/**
 * Walk the ladder.
 *
 * Pure, and separated from the lookups on purpose: the ORDER is the whole
 * feature, and an ordering bug is invisible in an integration test that happens
 * to have only one binding set.
 */
export function resolveConversationAgent(lookups: RoutingLookups): RoutingDecision {
  const threadBound = !!lookups.threadAgentId;

  if (lookups.addressedAgentId) {
    return { agentId: lookups.addressedAgentId, rung: 'addressed', threadBound };
  }
  if (lookups.threadAgentId) {
    return { agentId: lookups.threadAgentId, rung: 'thread', threadBound };
  }
  if (lookups.channelAgentId) {
    return { agentId: lookups.channelAgentId, rung: 'channel', threadBound };
  }
  if (lookups.workspaceDefaultAgentId) {
    return { agentId: lookups.workspaceDefaultAgentId, rung: 'workspace_default', threadBound };
  }
  if (lookups.suggestedAgentId) {
    return { agentId: lookups.suggestedAgentId, rung: 'suggested', threadBound };
  }
  return { agentId: null, rung: null, threadBound };
}

/**
 * May an explicit "talk to someone else" command take effect?
 *
 * Only from a rung that is not already a deliberate choice for this
 * conversation. Someone who bound this thread, or who named an agent in this
 * very message, has already said who they want; re-prompting them would throw
 * that away. A workspace default is not a choice about this conversation, so a
 * switch there is honoured.
 */
export function switchIsAllowed(decision: RoutingDecision): boolean {
  // A suggestion is not a choice about this conversation either, so a switch
  // from it is honoured exactly as from the workspace default.
  return decision.rung !== 'thread' && decision.rung !== 'addressed';
}

// Whether answering should CREATE a binding is deliberately not a function here.
//
// It was, briefly. But the event handler never binds on the auto-answer path at
// all — binding happens only where somebody chose explicitly, in the picker and
// in the review-DM flow. So the rule "a workspace-default answer must not bind"
// already holds by construction, and a helper restating it would be a control
// that looks like it is doing something while the real guarantee lives
// elsewhere. If the auto-answer path ever gains a bind, the rule belongs at
// that call site, where it can actually stop something.
//
// The property is pinned by a test on the handler instead — see
// profile-routing.test.ts, "never binds a conversation it merely answered".
