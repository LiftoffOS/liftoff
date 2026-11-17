// The reply says nothing was created. The run's own ledger says otherwise.
//
// A run can create a document (a battle card, say) during its retries and close
// by telling the person "No battle card was created or changed." while the
// document is there and the agent's OWN `search_documents` call finds it on the
// next turn.
//
// WHY THIS IS AT THE DELIVERY BOUNDARY AND NOT IN THE GRAPH.
//
// The obvious shape is `assertStepWorkWasDone`: throw when the step's account of
// itself disagrees with its record. That is unsafe here. It throws into workflow
// recovery, and recovery can replay the very write the report is about — so the
// fix would become a cause of the duplicate-write defect beside it
// (`agent-execution/step-replay-ledger.ts`). The last place a reply can be
// corrected without re-entering the graph is the boundary where it is delivered,
// which is where this runs.
//
// ONE NO-TOOLS COMPLETION, AND THE ONE THAT ALREADY EXISTS.
//
// `requestClosingReply` is the path a silent turn already goes through: a single
// completion, no tools, asking for the answer from a digest of what the turn did.
// A nudge that can call tools is a nudge that can act twice, and the whole point
// here is that the work already happened. So this reuses it with a digest of the
// WRITES rather than adding a second mechanism, and falls back to the reply it
// was given when the model produces nothing.
//
// A WRITE IS RECOGNISED, NEVER INFERRED.
//
// `nameHasMutatingVerb` is the only honest "this changed something" signal in the
// codebase: `classifyVendorToolEffect` answers `write` for a recognised mutating
// verb AND for any name it does not recognise, so it cannot tell the two apart.
// Here the difference decides whether a CORRECT reply gets rewritten, and the
// cost of a false positive is replacing a true "nothing was created" with a
// re-written one. So only a recognised mutating verb counts, and the in-process
// bookkeeping tools are excluded: the agent writing in its own notebook is not
// something a person was told about.

import { logger } from '../infrastructure/logging';
import { nameHasMutatingVerb } from '../tool-gateway/tool-effect';
import { isInProcessBookkeepingTool, normalizeToolName } from '../hitl-enforcement/tool-name-resolution';
import { canonicalJson } from '../agent-execution/sideeffect-idempotency';
import { buildStepSalvageDigest, type SalvageDigestCall } from '../agent-execution/engine/step-salvage-prompt';
import { requestClosingReply, type ClosingReplyInput } from './closing-reply';

/** One of the turn's tool calls, as the chat handler records them. */
export interface LedgerCall {
  name: string;
  input?: Record<string, unknown>;
  success?: boolean;
  result?: unknown;
  error?: string;
}

/** Things a run PRODUCES. A denial has to be about one of these, about the turn
 *  itself ("nothing"), or in the first person ("I did not create").
 *
 *  This list is the whole reason the check can be used at all. A verb test alone
 *  reads "Corvid Route did not change its pricing this week" as a denial, and
 *  that sentence is what a competitive analyst writes in a quiet week — so the
 *  correction would fire on the replies this agent produces most. The subject is
 *  what tells the run's own output from the world it was looking at. */
const PRODUCED = '(?:document|doc|docs|documents|file|files|card|cards|page|pages'
  + '|record|records|report|reports|digest|digests|snapshot|snapshots|note|notes'
  + '|entry|entries|row|rows|sheet|sheets|message|messages|draft|drafts'
  + '|comment|comments|issue|issues|ticket|tickets|spreadsheet|spreadsheets'
  + '|item|items|artifact|artifacts|change|changes|update|updates|edit|edits'
  + '|list|lists)';

/** The state a denial says was never reached. */
const PAST = '(?:created|changed|updated|written|added|made|modified|sent|posted|published)';
const PRESENT = '(?:create|change|update|write|add|make|modify|send|post|publish)';

/** A non-change this reply attributes to somebody ELSE.
 *
 *  The subject test above catches "Corvid Route did not change its pricing";
 *  this catches the passive form of the same thing, "the pricing page was not
 *  updated BY Corvid", where the produced-noun pattern would otherwise match. A
 *  sentence that names who did not act is a statement about the world, and this
 *  agent writes one most weeks.
 *
 *  Matched on a capitalised word or a quoted name after `by`, which is what an
 *  attribution looks like; `by us`, `by me` and `by the team` are not
 *  attributions to a third party and are deliberately not matched. */
const ATTRIBUTED_ELSEWHERE = /\bby\s+(?:"[^"]+"|[A-Z][\w'-]*)/;

/**
 * A reply that asserts nothing was created or changed.
 *
 * Read sentence by sentence, so "I wrote the card. No other documents were
 * changed." is judged on the sentence that denies rather than on the whole reply.
 *
 * WHAT THIS DELIBERATELY DOES NOT TRY TO BE: a verdict. It is a gate on asking
 * the model again with the record in hand, and the answer it gives is checked the
 * same way — a model that meant "the competitor's page did not change" says so
 * again, and the reply it was given stands. So the cost of a sentence this reads
 * too broadly is one completion, never a wrong claim.
 */
const DENIES_A_CHANGE: readonly RegExp[] = [
  // "Nothing was created." / "Nothing has been changed."
  new RegExp(`\\bnothing\\s+(?:else\\s+)?(?:was|were|has\\s+been|have\\s+been|is)?\\s*${PAST}\\b`, 'i'),
  // "No battle card was created or changed." / "No new document has been written."
  new RegExp(`\\bno\\s+(?:new\\s+|other\\s+|additional\\s+|further\\s+)?[\\w'"-]*\\s*${PRODUCED}\\b[^.!?]{0,40}?\\b(?:was|were|has\\s+been|have\\s+been)\\s+${PAST}\\b`, 'i'),
  // "The battle card was not created."
  new RegExp(`\\b${PRODUCED}\\b[^.!?]{0,40}?\\b(?:was|were|has|have)\\s+not\\s+(?:been\\s+)?${PAST}\\b`, 'i'),
  // First person: "I did not create any documents." / "I have not written it."
  new RegExp(`\\bi\\s+(?:did|do|have|had)\\s+not\\s+(?:been\\s+)?(?:${PRESENT}|${PAST})\\b`, 'i'),
  // "No changes were made."
  /\bno\s+(?:changes|updates|edits)\s+(?:were|have\s+been)\s+made\b/i,
];

/** Whether this reply asserts the run produced or changed nothing. Pure;
 *  exported for the test. */
export function deniesAnyChange(text: string | null | undefined): boolean {
  if (!text) return false;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some((s) => (
    !ATTRIBUTED_ELSEWHERE.test(s) && DENIES_A_CHANGE.some((re) => re.test(s))
  ));
}

/**
 * The turn's successful calls that CHANGED something, once each, in order.
 *
 * `success` absent is treated as a success, because the two records the chat
 * handler keeps differ: a completed call carries the flag and a collected one
 * (seen STARTING, never seen finishing) does not. Treating the second as a
 * failure would lose exactly the writes a cut-off turn made, which on some
 * engines is every write in it.
 *
 * DEDUPED, because one call is usually in both records: the handler collects it
 * when it starts and completes it when it finishes. Counted twice, the digest
 * tells the model two documents were written and it says so to a person — the
 * same class of wrong claim this whole correction exists to remove. The entry
 * that carries a RESULT wins, because that is the one the digest can report.
 *
 * A call that explicitly failed performed nothing and is not a write.
 *
 * Pure; exported for the test.
 */
export function successfulWrites(calls: readonly LedgerCall[]): LedgerCall[] {
  const byCall = new Map<string, LedgerCall>();
  for (const c of calls) {
    if (c.success === false) continue;
    if (!c.name) continue;
    if (isInProcessBookkeepingTool(c.name)) continue;
    if (!nameHasMutatingVerb(normalizeToolName(c.name))) continue;
    // The act, not the record of it: the same tool with the same arguments is
    // one call however many times the handler noted it.
    const key = `${normalizeToolName(c.name)}|${canonicalJson(c.input ?? {})}`;
    const held = byCall.get(key);
    if (!held || (held.result === undefined && c.result !== undefined)) byCall.set(key, c);
  }
  return [...byCall.values()];
}

export interface LedgerContradictionInput
  extends Pick<ClosingReplyInput, 'tenantId' | 'agentId' | 'threadId' | 'invocationId' | 'userMessage'> {
  /** The reply this turn is about to deliver. */
  replyText: string | null | undefined;
  /** Every call this turn made, completed and collected alike. */
  calls: readonly LedgerCall[];
}

/**
 * The reply to deliver INSTEAD, when the one proposed contradicts the ledger.
 *
 * Null when there is nothing to correct — the reply claims no such thing, or the
 * turn genuinely changed nothing — and null when the correction could not be
 * produced, in which case the caller delivers what it had. A reply that says
 * nothing happened is wrong; a reply that says nothing at all is worse.
 */
export async function correctReplyContradictingTheLedger(
  input: LedgerContradictionInput,
): Promise<string | null> {
  if (!deniesAnyChange(input.replyText)) return null;
  const writes = successfulWrites(input.calls);
  if (writes.length === 0) return null;

  logger.warn({
    threadId: input.threadId,
    invocationId: input.invocationId,
    writes: writes.map((c) => c.name),
  }, 'the reply says nothing was created or changed while the run recorded writes; asking for the answer again from the record');

  const digest = buildStepSalvageDigest(
    writes.map((c): SalvageDigestCall => ({
      name: c.name,
      input: c.input,
      success: true,
      result: c.result,
    })),
  );
  const corrected = await requestClosingReply({
    tenantId: input.tenantId,
    agentId: input.agentId,
    threadId: input.threadId,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    userMessage: input.userMessage,
    activityDigest: digest.text,
  });
  if (!corrected) return null;
  // A model that produces the same denial from the record has answered the
  // question put to it, and re-asking buys latency on a turn the person is
  // already waiting on. The proposed reply stands; the log line above is the
  // record that it did.
  if (deniesAnyChange(corrected)) {
    logger.warn({
      threadId: input.threadId,
      invocationId: input.invocationId,
    }, 'the correction denied the change as well; delivering the reply as it stood');
    return null;
  }
  return corrected;
}
