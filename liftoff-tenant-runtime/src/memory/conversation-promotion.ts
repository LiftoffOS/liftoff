// Should a working note outlive its conversation?
//
// `note_save` writes to the `conversation` layer: thread-scoped, 7-day expiry,
// and deliberately not part of who the agent is. Some of those notes turn out to
// be true beyond the thread — a connector quirk discovered while handling one
// ticket is a connector quirk. This decides which are CANDIDATES for promotion
// to `individual` or `global`.
//
// TWO RULES, and they are the whole design:
//
//   1. NOTHING IS EVER AUTO-PROMOTED. A candidate is recorded as a candidate.
//      Promotion is a reflection suggestion like any other, and goes through the
//      same review. The alternative — an agent that quietly rewrites its own
//      identity from a note it wrote about one ticket — is how a run's working
//      state becomes a permanent behaviour nobody chose.
//
//   2. IT REUSES THE EXISTING GATE. The reflection engine's evidence-density
//      arithmetic and its daily / weekly / concurrent quotas are the reason the
//      learning flywheel is affordable. Promotion asks the same questions rather
//      than inventing a second, looser standard beside them.
//
// Runs at terminal state, not mid-turn. On the Anthropic path the whole run is
// one adapter.invoke(), so there is no turn boundary to apply a refinement at —
// this is invocation-scoped by necessity, not by preference.

import { logger as log } from '../infrastructure/logging';
import type { Memory } from './types';

/** Minimum note length worth considering. A three-word note is a reminder to
 *  itself, not knowledge — and promoting one costs a reviewer's attention for
 *  something they cannot act on. */
const MIN_PROMOTABLE_LENGTH = 40;

/** Notes assessed per run. A run that wrote fifty notes is keeping working
 *  state, not discovering fifty durable facts, and reviewing fifty candidates
 *  is how a review queue stops being read. */
const MAX_CANDIDATES_PER_RUN = 5;

/** Phrases that mark a note as being ABOUT this thread. The strongest signal
 *  available without a model call, and cheap: a note naming "this ticket" or
 *  "the customer" is scoped by its own words. */
const THREAD_SPECIFIC = [
  /\bthis (?:ticket|thread|conversation|request|run|task|case)\b/i,
  /\bthe (?:customer|user|caller|requester) (?:said|asked|wants|mentioned|prefers)\b/i,
  /\b(?:for|in) this (?:one|instance|case)\b/i,
  /\btoday\b/i,
  /\bright now\b/i,
];

/** Phrases that mark a note as generalizable — a fact about a system rather
 *  than about a moment. */
const GENERALIZABLE = [
  /\b(?:always|never|whenever|any time)\b/i,
  /\bAPI\b|\bendpoint\b|\brate limit\b|\bschema\b|\bconnector\b/i,
  /\b(?:returns?|requires?|expects?|rejects?)\b/i,
  /\berror\b|\bfails? with\b|\bgotcha\b/i,
];

export interface PromotionCandidate {
  memoryId: string;
  content: string;
  /** Which layer it is being proposed FOR, never written to. */
  proposedLayer: 'individual' | 'global';
  reason: string;
}

export interface PromotionAssessment {
  candidates: PromotionCandidate[];
  /** Why nothing was proposed, when nothing was. Present so a run that produced
   *  no candidates can be told apart from one where the gate never ran — the
   *  same distinction the verify gate needed and did not have. */
  declineReason?: 'no_notes' | 'below_evidence_density' | 'quota_exhausted' | 'none_generalizable';
}

/** Assess this thread's notes for promotion. Pure: it proposes, and writes
 *  nothing. */
export function assessNotesForPromotion(notes: Memory[]): PromotionAssessment {
  if (notes.length === 0) return { candidates: [], declineReason: 'no_notes' };

  const candidates: PromotionCandidate[] = [];
  for (const note of notes) {
    const content = (note.content ?? '').trim();
    if (content.length < MIN_PROMOTABLE_LENGTH) continue;
    // A note about this thread stays with this thread, whatever else it says.
    // Checked first because a note can be both, and the specific reading is the
    // safe one: promoting a thread-scoped fact makes it advice for every future
    // conversation.
    if (THREAD_SPECIFIC.some((re) => re.test(content))) continue;
    if (!GENERALIZABLE.some((re) => re.test(content))) continue;

    candidates.push({
      memoryId: note.id,
      content,
      // `individual` rather than `global`, always. A note this agent wrote while
      // doing its own work is evidence about its own work; proposing it for the
      // whole workspace asks a reviewer to accept a much larger claim on the
      // same evidence.
      proposedLayer: 'individual',
      reason: 'reads as a durable fact rather than as working state for this thread',
    });
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
  }

  return candidates.length > 0
    ? { candidates }
    : { candidates: [], declineReason: 'none_generalizable' };
}

export interface PromotionGateDeps {
  /** The reflection engine's own evidence-density reading for this agent,
   *  0..1. Promotion asks the same question rather than inventing a second,
   *  looser standard beside it. */
  evidenceDensity: () => Promise<number>;
  /** The reflection engine's own quota status. */
  quotaAvailable: () => Promise<boolean>;
  /** Record a candidate for review. Never writes a memory. */
  recordCandidate: (c: PromotionCandidate) => Promise<void>;
}

/** The same threshold `startReflection` applies. Named rather than repeated so
 *  the two cannot drift apart silently. */
export const MIN_EVIDENCE_DENSITY_FOR_PROMOTION = 0.5;

/** Run the gate at terminal state.
 *
 *  Best-effort throughout: a promotion assessment must never change the outcome
 *  of the run that produced the notes. */
export async function runPromotionGate(
  notes: Memory[],
  deps: PromotionGateDeps,
): Promise<PromotionAssessment> {
  try {
    const assessment = assessNotesForPromotion(notes);
    if (assessment.candidates.length === 0) return assessment;

    if (!await deps.quotaAvailable()) {
      return { candidates: [], declineReason: 'quota_exhausted' };
    }
    const density = await deps.evidenceDensity();
    if (density < MIN_EVIDENCE_DENSITY_FOR_PROMOTION) {
      return { candidates: [], declineReason: 'below_evidence_density' };
    }

    for (const c of assessment.candidates) {
      await deps.recordCandidate(c).catch((err: Error) => {
        log.warn({ err: err.message, memoryId: c.memoryId }, 'could not record a promotion candidate');
      });
    }
    return assessment;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'promotion gate failed (non-fatal)');
    return { candidates: [], declineReason: 'no_notes' };
  }
}
