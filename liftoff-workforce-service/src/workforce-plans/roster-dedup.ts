// Roster dedup detection for CAIO team drafting.
//
// The CAIO can already SEE the existing roster (org__get_existing_structure)
// and the prompt tells it to avoid duplicates, but that guidance lives only in
// the prompt: a model that skips the roster call, or reads it and proposes a
// near-duplicate anyway, provisions a second team that does the same job as one
// the workspace already runs. The guardrail was wired at one end.
//
// This computes an overlap signal between each proposed spec and the existing
// teams so workforce_plan__draft can direct the CAIO to route to the existing
// team (extend it through team__propose_update, or drop the duplicate spec)
// rather than build a duplicate. It is advisory to the CAIO, never a hard
// block: only the user and the CAIO know whether a genuinely distinct team is
// wanted, and a token overlap cannot decide that for them.
//
// Matching is deliberately conservative to earn its directive tone. A strong
// signal (same or subsuming name) reads as a duplicate; a lighter token
// overlap reads as scope overlap the CAIO must confirm before provisioning.

import type { RawAgent } from './tenant-agents.js';
import type { WorkforcePlanAgentSpec } from './types.js';

/** Tokens that carry no distinguishing meaning between two team names, so
 *  leaving them in would let "Sales Agent" and "Support Agent" share the word
 *  that made them look alike. Domain words (sales, support, finance) are kept
 *  on purpose — they are exactly what tells two teams apart. */
const GENERIC_TOKENS = new Set([
  'agent', 'agents', 'team', 'teams', 'ai', 'assistant', 'assistants', 'bot',
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with',
  'our', 'your', 'my', 'this', 'that',
]);

/** A jaccard at or above this on the combined name+summary tokens reads as
 *  overlapping scope worth confirming. Calibrated to catch real overlap
 *  ("Sales Development team" vs "Sales Development Reps") while leaving merely
 *  same-department teams ("Sales Manager" vs "Sales Specialist", jaccard 0.33)
 *  unflagged. */
const OVERLAP_JACCARD = 0.5;

export type DuplicateKind = 'duplicate' | 'overlap';

export interface DuplicateMatch {
  /** The proposed spec that overlaps an existing team. */
  specId: string;
  specName: string;
  /** The existing team it overlaps, and its live status, so the CAIO can name
   *  it to the user and target it with team__propose_update. */
  existingAgentId: string;
  existingAgentName: string;
  existingStatus: string;
  kind: DuplicateKind;
  /** Jaccard similarity of the combined name+summary tokens, rounded. */
  score: number;
}

/** lowercase, split on non-alphanumerics, drop generic tokens. */
function meaningfulTokens(...parts: Array<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length === 0) continue;
      if (GENERIC_TOKENS.has(raw)) continue;
      out.add(raw);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isSubsetOrEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

/**
 * Best-matching existing team for each proposed spec, at or above the overlap
 * threshold. Returns at most one match per spec (its strongest), so the CAIO
 * gets one clear routing target rather than a list to reconcile.
 *
 * `currentPlanId` excludes the plan's OWN already-provisioned teams: an
 * amendment redraft carries specs that match the very rows the last approval
 * created, and flagging a team as a duplicate of itself would be nonsense. A
 * plan still in draft has provisioned nothing, so nothing is excluded there.
 */
export function detectRosterDuplicates(
  specs: WorkforcePlanAgentSpec[],
  existingAgents: RawAgent[],
  currentPlanId?: string,
): DuplicateMatch[] {
  const candidates = existingAgents.filter((a) => {
    // Only teams that actually exist in the workspace count as duplicates.
    // Every non-draft/active/paused status (e.g. a soft-deleted row, if the
    // roster ever surfaces one) is ignored rather than treated as live.
    const status = a.status ?? 'draft';
    if (status !== 'active' && status !== 'draft' && status !== 'paused') return false;
    // Never match a plan against the teams it has itself provisioned.
    if (currentPlanId && a.workforcePlanId && a.workforcePlanId === currentPlanId) return false;
    return true;
  });
  if (candidates.length === 0) return [];

  // Precompute each candidate's token sets once.
  const candidateTokens = candidates.map((a) => ({
    agent: a,
    nameTokens: meaningfulTokens(a.role),
    allTokens: meaningfulTokens(a.role, (a.responsibilities ?? '').slice(0, 240)),
  }));

  const matches: DuplicateMatch[] = [];
  for (const spec of specs) {
    const specNameTokens = meaningfulTokens(spec.name);
    const specAllTokens = meaningfulTokens(spec.name, (spec.roleSummary ?? '').slice(0, 240));

    let best: DuplicateMatch | null = null;
    for (const cand of candidateTokens) {
      const score = jaccard(specAllTokens, cand.allTokens);
      // A shared or subsuming NAME is the strong duplicate signal; the combined
      // token jaccard catches scope overlap when names diverge.
      const strongName = isSubsetOrEqual(specNameTokens, cand.nameTokens);
      const kind: DuplicateKind | null = strongName
        ? 'duplicate'
        : score >= OVERLAP_JACCARD
          ? 'overlap'
          : null;
      if (!kind) continue;

      // Keep the strongest: a duplicate always beats an overlap; between two of
      // the same kind, the higher jaccard wins.
      const better =
        !best ||
        (kind === 'duplicate' && best.kind === 'overlap') ||
        (kind === best.kind && score > best.score);
      if (!better) continue;

      best = {
        specId: spec.specId,
        specName: spec.name,
        existingAgentId: cand.agent.id,
        existingAgentName: cand.agent.role ?? cand.agent.id,
        existingStatus: cand.agent.status ?? 'draft',
        kind,
        score: Math.round(score * 100) / 100,
      };
    }
    if (best) matches.push(best);
  }
  return matches;
}

/**
 * The guidance line the draft tool appends to its result message when a spec
 * overlaps an existing team. Directive for a duplicate (route, do not build a
 * second one), a confirmation prompt for a lighter overlap. Model-facing
 * guidance, not user copy: it tells the CAIO which existing team to route to
 * and how.
 */
export function renderDuplicateGuidance(matches: DuplicateMatch[]): string {
  if (matches.length === 0) return '';
  const lines = matches.map((m) => {
    if (m.kind === 'duplicate') {
      return `- Proposed team "${m.specName}" closely matches an existing ${m.existingStatus} team, "${m.existingAgentName}" (id ${m.existingAgentId}). Do NOT provision a duplicate. Route to the existing team: if the user wants it changed, read team__get_config for that id and use team__propose_update; otherwise remove this spec from the plan and tell the user the team already exists.`;
    }
    return `- Proposed team "${m.specName}" overlaps in scope with an existing ${m.existingStatus} team, "${m.existingAgentName}" (id ${m.existingAgentId}). Before provisioning, confirm with the user this is genuinely a new team. If the work belongs to the existing one, route to it with team__propose_update rather than creating a second team.`;
  });
  return `\n\nDUPLICATE CHECK — this plan overlaps teams the workspace already has:\n${lines.join('\n')}`;
}
