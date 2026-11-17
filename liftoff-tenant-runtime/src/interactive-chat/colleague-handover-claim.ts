// The turn claims a hand-over to the Chief AI Officer only when a request was
// actually registered.
//
// A person can ask a team to automate what they have both just done and get
// the reply "I will have the Chief AI Officer draft the automation" with no
// tool call at all: nothing is registered, no preview comes, and the person
// waits. The prompt tells a team to call `bring_in_colleague` for exactly
// this ask; a prompt rule is a hope, and some engines narrate the call
// instead of making it.
//
// Two halves. `claimsChiefAiOfficerHandover` reads the reply for a claim
// that the Chief AI Officer will act on this ask: a sentence that names the
// Chief AI Officer and carries a future intent (will have, bringing in,
// shortly). It stays silent on the one sentence the prompt asks a team to
// say WITHOUT bringing anyone in, that the Chief AI Officer designs new AI
// teams in its own chat. `honourClaimedHandover` then makes a claim true
// when the turn did not: it registers the design change on the team's
// behalf through the same rail the tool uses, with the person's own message
// as the request (the Chief AI Officer reads the conversation and its
// browser trail itself; a forwarded request is never the specification),
// and when that cannot be done it answers the sentence the reply must carry
// instead, so the person is never left waiting for a preview that is not
// coming. As the escalation sentence: driven from the record, never from
// the prose.

import { logger } from '../infrastructure/logging';
import { registerColleagueRequest } from '../platform-callback/client';
import { colleagueRefusalSentence } from '../tools/bring-in-colleague-handler';

const CHIEF_AI_OFFICER = /chief ai officer/i;
/** A future intent beside the name: the reply says the colleague WILL act. */
const HANDOVER_INTENT =
  /\b(?:will|going to|about to|let me|i am|i'm|i'll|i will)\b[^.!?]*\b(?:have|ask|bring|post|draft|prepare|propose|put|share|write|hand|pass|loop|get|send|involve|reach)\b|\b(?:bringing|brought|handing|handed|passing|passed|looping|looped|involving)\b|\bshortly\b/i;
/** The sentence the prompt asks a team to say when the person wants a NEW
 *  agent: the Chief AI Officer designs those elsewhere, and nobody is
 *  brought in. */
// Matches the new noun and the retired one. The rename moved the sentence this
// exclusion exists for — a model saying "the Chief AI Officer designs new agents
// elsewhere" is declining to hand over, not promising to — and a pattern that
// only knew the old wording would have read that as a claim and registered a
// handover nobody asked for. The old spelling is kept because a model that has
// read older context can still produce it, and matching both costs nothing.
const DESIGNS_ELSEWHERE = /designs new (?:agents|ai teams)/i;

/** Whether the reply claims that the Chief AI Officer will act on this ask.
 *  Pure; exported for the test. */
export function claimsChiefAiOfficerHandover(text: string | null | undefined): boolean {
  if (!text) return false;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some((s) => CHIEF_AI_OFFICER.test(s) && !DESIGNS_ELSEWHERE.test(s) && HANDOVER_INTENT.test(s));
}

/** Whether the turn actually called bring_in_colleague. A tool name reaches
 *  here as the catalog spells it or namespaced by an SDK engine
 *  (`mcp__…__bring_in_colleague`); the suffix is the fact. */
export function calledBringInColleague(toolCallNames: readonly string[]): boolean {
  return toolCallNames.some((n) => n === 'bring_in_colleague' || n.endsWith('__bring_in_colleague'));
}

export interface HonourClaimedHandoverInput {
  replyText: string | null | undefined;
  toolCallNames: readonly string[];
  tenantId: string;
  /** Runtime-space agents.id, as the tool context carries it. */
  agentId: string;
  /** Control-plane internal_agents.id, which the chat turn already holds. */
  internalAgentId: string;
  threadId: string;
  /** The person's own message this turn answered: the request, in their
   *  terms. */
  personMessage: string;
}

export interface HonouredHandover {
  /** What was done about the claim. */
  action: 'none' | 'registered' | 'refused' | 'failed';
  /** A sentence the reply must carry when the claim could not be made true;
   *  null when nothing needs saying. */
  correction: string | null;
}

const NOT_BROUGHT_IN =
  'Correction: the Chief AI Officer has not been brought in, because the request could not be '
  + 'registered just now. You can ask the Chief AI Officer directly, or ask me again in a moment.';

/**
 * Make a claimed hand-over true, or say that it is not.
 *
 * Nothing happens for a reply that makes no claim, or for a turn that made
 * the call itself (its result, a registration or a refusal, is already in
 * the reply). Never throws: a failure to register is a correction, not a
 * failed turn.
 */
export async function honourClaimedHandover(input: HonourClaimedHandoverInput): Promise<HonouredHandover> {
  if (!claimsChiefAiOfficerHandover(input.replyText)) return { action: 'none', correction: null };
  if (calledBringInColleague(input.toolCallNames)) return { action: 'none', correction: null };
  const context = { tenantId: input.tenantId, agentId: input.internalAgentId, threadId: input.threadId };
  const request = input.personMessage.trim();
  if (!request) {
    logger.warn({ ...context, event: 'chat_colleague_handover_unbacked' }, 'the reply claims a Chief AI Officer hand-over the turn never made, and there is no message to forward');
    return { action: 'failed', correction: NOT_BROUGHT_IN };
  }
  try {
    const outcome = await registerColleagueRequest({
      tenantId: input.tenantId,
      agentId: input.agentId,
      internalAgentId: input.internalAgentId,
      threadId: input.threadId,
      colleague: 'caio',
      request,
    });
    if ('registered' in outcome && outcome.registered) {
      logger.info({ ...context, event: 'chat_colleague_handover_backfilled' }, 'the reply claimed a Chief AI Officer hand-over the turn never made; the request was registered on its behalf');
      return { action: 'registered', correction: null };
    }
    const reason = 'reason' in outcome && outcome.reason ? outcome.reason : 'not_recorded';
    logger.warn({ ...context, reason, event: 'chat_colleague_handover_refused' }, 'the reply claimed a Chief AI Officer hand-over the turn never made, and the request was refused');
    if (reason === 'unavailable' || reason === 'not_registerable' || reason === 'not_recorded') {
      return { action: 'failed', correction: NOT_BROUGHT_IN };
    }
    return { action: 'refused', correction: `Correction: ${colleagueRefusalSentence(reason)}` };
  } catch (err) {
    logger.warn({ ...context, err: (err as Error).message, event: 'chat_colleague_handover_failed' }, 'the reply claimed a Chief AI Officer hand-over the turn never made, and registering it failed');
    return { action: 'failed', correction: NOT_BROUGHT_IN };
  }
}
