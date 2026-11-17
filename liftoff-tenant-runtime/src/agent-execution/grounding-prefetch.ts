// The grounding floor: the host runs an agent's first read, on every engine.
//
// `groundsOn` declares which read a request's SHAPE needs — "what is your
// refund window" always wants the policy corpus, "where is my ticket" always
// wants the work queue. Neither is a judgment call, and an agent asked to make
// it will sometimes decide wrong; when it does, the answer is confidently
// unsourced, which is the worst failure available.
//
// PREFETCH IS THE FLOOR, NOT THE OPTIMISATION. It works identically on all
// engines because no engine is asked to produce it — the host runs the read and
// appends the result. Native tool-forcing, where a vendor exposes it, makes the
// model author the arguments (a composed search query) and is strictly an
// improvement on top; an engine that cannot force, or a model that rejects the
// parameter, still gets the floor. That ordering is the whole design: a
// guarantee whose mechanism is per-vendor is not a guarantee, it is a
// coincidence that holds for whichever vendor was checked.
//
// THROUGH THE GOVERNED GATEWAY, never a direct connector call. The read is a
// tool call the agent would otherwise have made, so it passes the same gates,
// gets the same untrusted-content framing and is metered the same way. A
// host-initiated read that skipped those would be a hole straight through the
// governance surface, opened by a performance feature.

import { logger } from '../infrastructure/logging';
import { withDeadline, isDeadlineExceeded } from '../infrastructure/deadline';

/**
 * How long the opening turn waits for its grounding read.
 *
 * The read runs before the engine starts, so every second of it is a second the
 * person watches nothing happen, and on a dead pooled connection it would wait
 * for the gateway's own deadline — minutes. It is a search (a corpus or a work
 * queue), normally back in a few seconds, and it is optional: without it the
 * agent still has the tool. 15s is several times a normal read; past it the
 * turn proceeds ungrounded. The abandoned read still ends at the gateway
 * client's own deadline.
 */
export const GROUNDING_PREFETCH_DEADLINE_MS = 15_000;

/** One declared rule, as the runtime receives it. Mirrors PB's GroundsOnRule;
 *  duplicated rather than imported because the two repos share no types
 *  package for this, and the shape is five fields. */
export interface GroundsOnRule {
  label: string;
  terms: string[];
  cues: string[];
  toolName: string;
  enabled: boolean;
}

/**
 * Whether a turn matches a rule.
 *
 * Whole-word, and BOTH halves required. Substring matching fires "cancel" on
 * "cancer"; a term with no cue fires on "I already refunded them", which is a
 * statement about work done rather than a question needing the policy.
 *
 * Byte-identical in intent to the distiller's own matcher. Two implementations
 * would be two answers to "did this turn match", and the disagreement would
 * show up as a rule that fires in testing and not in production.
 */
export function turnMatchesRule(turn: string, rule: GroundsOnRule): boolean {
  if (!rule.enabled) return false;
  const text = (turn ?? '').toLowerCase();
  if (!text) return false;
  const hasWord = (w: string): boolean =>
    w === '?' ? text.includes('?') : new RegExp(`\\b${escapeWord(w)}\\b`).test(text);
  return rule.terms.some(hasWord) && rule.cues.some(hasWord);
}

function escapeWord(w: string): string {
  return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first rule a turn matches, or null.
 *
 *  FIRST, not all. Two prefetches on one turn is two tool calls the person did
 *  not ask for, and the second is nearly always the weaker match — the rules
 *  are ordered by how specific they are, so taking the first is taking the
 *  best. */
export function ruleForTurn(
  turn: string,
  rules: readonly GroundsOnRule[] | undefined,
): GroundsOnRule | null {
  for (const rule of rules ?? []) {
    if (turnMatchesRule(turn, rule)) return rule;
  }
  return null;
}

/**
 * The labelled block a prefetched result is appended under.
 *
 * It says what it is and where it came from, in those words, because the model
 * has to be able to tell host-fetched data from something the user typed. An
 * unlabelled paste is indistinguishable from the person having quoted their own
 * help centre, and an agent cannot reason about the reliability of a source it
 * cannot see.
 */
export function groundingBlock(rule: GroundsOnRule, resultText: string): string {
  return [
    '',
    `Fetched by the host — the same data a ${rule.toolName} call returns:`,
    '',
    resultText,
  ].join('\n');
}

export interface PrefetchOutcome {
  /** The block to append, or null when nothing was fetched. */
  block: string | null;
  /** The rule that fired, for telemetry. */
  rule: GroundsOnRule | null;
}

/**
 * Evaluate the rules against a turn and run the winning read.
 *
 * A FAILED PREFETCH IS NOT A FAILED TURN. It logs a warning and returns no
 * block: the agent still has the tool and can call it itself. Failing the turn
 * would make a latency optimisation into a new way for the product to break,
 * and the thing it was optimising still works without it.
 */
export async function runGroundingPrefetch(args: {
  turn: string;
  rules: readonly GroundsOnRule[] | undefined;
  tenantId: string;
  agentId: string;
  invocationId?: string;
  /** Runs the read THROUGH THE GOVERNED GATEWAY. Injected so this module never
   *  holds a connector client of its own — the only way to be sure the gates,
   *  the framing and the metering are the ones the agent's own calls get. */
  dispatch: (toolName: string, query: string) => Promise<{ ok: boolean; text: string }>;
  /** Test seam; GROUNDING_PREFETCH_DEADLINE_MS otherwise. */
  deadlineMs?: number;
}): Promise<PrefetchOutcome> {
  const rule = ruleForTurn(args.turn, args.rules);
  if (!rule) return { block: null, rule: null };

  const deadlineMs = args.deadlineMs ?? GROUNDING_PREFETCH_DEADLINE_MS;
  try {
    const result = await withDeadline(
      `grounding prefetch ${rule.toolName}`,
      deadlineMs,
      () => args.dispatch(rule.toolName, args.turn),
    );
    if (!result.ok || !result.text.trim()) {
      logger.warn({
        event: 'grounding_prefetch_empty',
        metric: 'grounding.prefetch_empty',
        tenantId: args.tenantId,
        agentId: args.agentId,
        invocationId: args.invocationId,
        toolName: rule.toolName,
      }, 'grounding prefetch returned nothing; the turn proceeds and the agent may still call the tool');
      return { block: null, rule };
    }

    logger.info({
      event: 'grounding_prefetch_applied',
      metric: 'grounding.prefetch_applied',
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.invocationId,
      toolName: rule.toolName,
      label: rule.label,
    }, 'grounded the turn from the declared read');
    return { block: groundingBlock(rule, result.text), rule };
  } catch (err) {
    if (isDeadlineExceeded(err)) {
      logger.warn({
        event: 'grounding_prefetch_timed_out',
        metric: 'grounding.prefetch_timed_out',
        tenantId: args.tenantId,
        agentId: args.agentId,
        invocationId: args.invocationId,
        toolName: rule.toolName,
        deadlineMs,
      }, 'grounding prefetch timed out; the turn proceeds ungrounded and the agent may still call the tool');
      return { block: null, rule };
    }
    logger.warn({
      event: 'grounding_prefetch_failed',
      metric: 'grounding.prefetch_failed',
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.invocationId,
      toolName: rule.toolName,
      err: (err as Error).message,
    }, 'grounding prefetch failed; the turn proceeds');
    return { block: null, rule };
  }
}
