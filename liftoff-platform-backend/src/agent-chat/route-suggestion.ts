// Who answers, when nobody was chosen (Phase 9).
//
// Every routing ladder in the estate encodes a recorded human choice first —
// a name in the message, a thread binding, a channel binding, a workspace
// default, a thread lead — and falls back only when there is none. Nothing
// here sits above those rungs. This is the FALLBACK only: one `ask` of the
// route_message set over the workspace's active teams, replacing the picker
// on an unbound addressed Slack or Teams message and the ILIKE keyword rung
// in a multi-agent dashboard thread.
//
// Two rules the workspace-default rung already states are kept: a fallback
// answers WHO, never whether to speak (an un-addressed message stays
// un-answered whatever this would pick), and a fallback never becomes a
// binding — the caller answers from the suggestion and binds nothing, so a
// later explicit choice is still a first choice rather than a correction.
//
// Usage is one row per call, finalised FROM THE ANSWER: a confident choice
// writes `route_message` with the chosen team's internal_agents.id (customer
// usage); `none`, a sub-threshold answer or a failed call writes
// `route_message_none` (platform overhead — a request that picked nobody is
// the platform's).

import { ask } from '../typesafe/client';
import { isTypeSafeRoutingEnabled } from '../typesafe/flags';
import {
  ROUTE_CANDIDATE_CAP,
  ROUTE_MESSAGE_MAX_CHARS,
  ROUTE_SUMMARY_MAX_CHARS,
  routeMessageSet,
  type RouteCandidate,
} from '../typesafe/questions';
import { log } from '../infrastructure/logging';

export interface RouteSuggestionInput {
  tenantId: string;
  message: string;
  channel: { kind: 'dm' | 'channel' | 'thread'; name?: string };
  candidates: RouteCandidate[];
  /** For the log line only. */
  surface: 'slack' | 'teams' | 'dashboard';
}

export interface RouteSuggestion {
  agentId: string;
  probability: number;
}

function bound(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The suggested answerer, or null: the kill is off, the roster is empty or
 * over the cap, the vendor did not answer, the answer was `none`, or it was
 * below ROUTE_T. Null means "the surface's own fallback": the picker, or the
 * ILIKE rung. Never throws.
 */
export async function suggestAnswerer(input: RouteSuggestionInput): Promise<RouteSuggestion | null> {
  if (!isTypeSafeRoutingEnabled()) return null;
  if (input.candidates.length === 0) return null;
  if (input.candidates.length > ROUTE_CANDIDATE_CAP) {
    log.info({ metric: 'route.suggested.over_cap', tenantId: input.tenantId, candidates: input.candidates.length, surface: input.surface },
      'roster over the routing cap; the surface falls back');
    return null;
  }
  const candidates = input.candidates.map((c) => ({
    id: c.id,
    role: bound(c.role, 200),
    summary: bound(c.summary, ROUTE_SUMMARY_MAX_CHARS),
  }));
  const set = routeMessageSet(candidates);
  const routeT = set.thresholds.ROUTE_T as number;
  const ids = new Set(candidates.map((c) => c.id));

  const result = await ask(
    set,
    {
      message: bound(input.message, ROUTE_MESSAGE_MAX_CHARS),
      channel: { kind: input.channel.kind, ...(input.channel.name ? { name: bound(input.channel.name, 200) } : {}) },
      candidates,
    },
    {
      deadlineMs: 4_000,
      attemptTimeoutMs: 2_500,
      maxRetries: 1,
      // The default when the call fails: a request that picked nobody.
      purpose: 'route_message_none',
      tenantId: input.tenantId,
      finalize: (answers) => {
        const a = (answers as { answerer?: { choice?: string; probabilities?: Record<string, number> } }).answerer;
        const choice = a?.choice;
        const p = choice ? (a?.probabilities?.[choice] ?? 0) : 0;
        if (choice && choice !== 'none' && ids.has(choice) && p >= routeT) {
          return { purpose: 'route_message', agentId: choice };
        }
        return { purpose: 'route_message_none' };
      },
    },
  );
  if (!result) return null;
  const answer = result.answers.answerer;
  const p = answer.probabilities[answer.choice] ?? 0;
  if (answer.choice === 'none' || !ids.has(answer.choice) || p < routeT) {
    log.info({ metric: 'route.suggested.none', tenantId: input.tenantId, surface: input.surface, choice: answer.choice, probability: p },
      'no team suggested; the surface falls back');
    return null;
  }
  return { agentId: answer.choice, probability: p };
}
