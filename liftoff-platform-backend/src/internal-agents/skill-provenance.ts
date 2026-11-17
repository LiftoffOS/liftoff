// Skill provenance merge — keeps a redistill from destroying what a team
// member learned.
//
// Two authors write skills: the distiller (every create / Optimize / redistill)
// and the reflection flywheel (skill-feedback-service, plus operator edits and
// imports). Before this module, `service.update` took the incoming array
// verbatim, so a single Optimize replaced the whole set and every learned
// refinement and pitfall skill vanished — silently, because the runtime's
// supersede-then-insert then mirrored the loss.
//
// The merge rule, by provenance of the INCOMING array:
//
//   distilled caller (create / redistill / distill-then-save)
//     - replaces the previous `distilled` slice wholesale (that is what a
//       redistill is for)
//     - passes every `learned` / `operator` skill through untouched
//     - drops a fresh distilled skill that duplicates a preserved one, so a
//       redistill cannot re-create a skill reflection already owns
//
//   archived skills, under either caller
//     - always preserved, never re-authored, never un-archived implicitly. The
//       runtime never sees them; only an explicit restore brings one back.
//
//   operator caller (PUT edit, skill steering verbs, import)
//     - the incoming array is authoritative for the skills it names; anything
//       it omits is preserved by provenance exactly as above
//     - an edited skill becomes `operator` + `protected`, which takes it out of
//       the flywheel's reach until a human unprotects it
//
// Identity is by `id` first, then case-insensitive `name` (legacy rows carry no
// id). Dedup of fresh distilled output against preserved skills uses the same
// embedding similarity the flywheel uses, and fails open — an embed outage
// means "keep both", never "drop the learned one".

import { randomUUID } from 'crypto';
import { log } from '../infrastructure/logging';
import { findNearestSkill } from './skill-similarity';
import type { Skill, SkillProvenance } from './types';

/** Similarity at or above which a freshly distilled skill is considered a
 *  duplicate of a preserved learned/operator skill and is dropped. Matches the
 *  flywheel's HIGH_MERGE_THRESHOLD intent (near-identical), deliberately
 *  conservative: a false negative costs one duplicate skill, a false positive
 *  costs a real capability. */
const DISTILL_DUPLICATE_THRESHOLD = 0.92;

/** Legacy rows predate provenance; they were all distiller output. */
export function normalizeSkillProvenance(skill: Skill): SkillProvenance {
  return skill.provenance ?? 'distilled';
}

function identityKey(skill: Skill): string {
  return skill.id ? `id:${skill.id}` : `name:${skill.name.trim().toLowerCase()}`;
}

export interface SkillMergeResult {
  skills: Skill[];
  /** Per-provenance counts for telemetry and the redistill dry-run diff. */
  stats: {
    incoming: number;
    replaced: number;
    preservedLearned: number;
    preservedOperator: number;
    deduped: number;
  };
}

export interface SkillMergeOptions {
  /** Provenance stamped on every incoming skill that does not carry one. */
  incomingProvenance: SkillProvenance;
  tenantId: string;
  agentId: string;
  /** Skips the embedding dedup pass. Used by unit tests and by callers that
   *  have already deduped (the flywheel does its own). */
  skipDedup?: boolean;
}

/**
 * What provenance an incoming skill actually gets.
 *
 * A client legitimately round-trips provenance: the skills list it PUTs back is
 * the list it read, and a distilled skill must stay distilled across an
 * unrelated edit. But a client-asserted value is still client input, and two
 * assertions must never be taken at face value:
 *
 * The only claim that can cause harm is a DOWNGRADE: `distilled` asserted over a
 * skill that is currently `learned` or `operator`. That marks real work as
 * re-authorable, and the next redistill deletes it — precisely the loss this
 * module exists to prevent, reachable by a stale client sending back an old
 * copy. So downgrades are refused.
 *
 * Claiming `learned` is deliberately NOT refused, though it looks like the
 * forgeable one. Weigh what it actually grants: a `learned` skill survives
 * redistill and stays writable by the flywheel, while `operator` — which any
 * client may assert, because that is how the edit and protect verbs work —
 * survives redistill AND is protected from the flywheel entirely. `learned` is
 * strictly the weaker claim, so refusing it protects nothing.
 *
 * Refusing it did cause harm: the skills GET labels a runtime skill the column
 * has not recorded yet as `learned` (it is the platform's own statement, not
 * the client's), so an ordinary settings save round-tripped that label, had it
 * rejected, and silently converted a live flywheel skill to operator+protected
 * — permanently removing it from the flywheel's reach.
 */
function resolveIncomingProvenance(
  incoming: Skill,
  existing: Skill | undefined,
  callerProvenance: SkillProvenance,
  agentId: string,
): SkillProvenance {
  const claimed = incoming.provenance;
  if (!claimed) return callerProvenance;

  // A genuine round-trip: the claim is what we already have on file.
  if (existing && normalizeSkillProvenance(existing) === claimed) return claimed;

  // Nothing stored to downgrade. `distilled` is how the distill-then-save path
  // marks fresh output; `learned` is how the skills GET labels a skill the
  // runtime is already running that the column has not caught up to.
  if (!existing) return claimed;

  // Stored, and the claim differs. Only a downgrade to `distilled` is refused —
  // that is the one that gets real work deleted by the next redistill.
  if (claimed !== 'distilled') return claimed;

  log.warn(
    {
      agentId,
      skillName: incoming.name,
      claimed,
      stored: existing ? normalizeSkillProvenance(existing) : null,
      applied: callerProvenance,
    },
    'skill-provenance: refused a downgrade to distilled — the next redistill would have deleted this skill',
  );
  return callerProvenance;
}

/**
 * Merge an incoming skill array onto the currently stored one by provenance.
 *
 * `current` is the authoritative platform-side set (internal_agents.skills).
 * The result is a full set, safe to persist and to publish to the runtime.
 */
export async function mergeSkillsByProvenance(
  current: Skill[],
  incoming: Skill[],
  options: SkillMergeOptions,
): Promise<SkillMergeResult> {
  const { incomingProvenance, tenantId, agentId } = options;

  const currentByKey = new Map(current.map((s) => [identityKey(s), s]));

  const stamped: Skill[] = [];
  for (const s of incoming) {
    const existing = currentByKey.get(identityKey(s));
    const effectiveProvenance = resolveIncomingProvenance(s, existing, incomingProvenance, agentId);

    // A protected skill is a human's: only another operator write may replace
    // it. A distilled caller that happens to emit the same skill is dropped
    // here, so the stored version survives intact rather than being shadowed
    // by a duplicate.
    if (existing?.protected && incomingProvenance !== 'operator') {
      log.info(
        { agentId, skillName: existing.name },
        'skill-provenance: incoming skill dropped — target is operator-protected',
      );
      continue;
    }

    stamped.push({
      ...s,
      // Inherit the matched skill's id so a re-author keeps one identity. Safe
      // for the key matching below: when `existing` has an id both sides key on
      // that same id, so `incomingKeys` still recognises the row it replaces.
      ...(existing?.id && !s.id ? { id: existing.id } : {}),
      // Files survive a re-author of the TEXT. A redistill and the reflection
      // flywheel both rewrite `instruction`, and a skill whose wording improved
      // has not thereby lost the scripts it ships with — dropping them would
      // leave the new text describing tools that are no longer there. Only a
      // caller that carries its own bundle (a re-import) replaces it.
      ...(existing?.bundle && s.bundle === undefined ? { bundle: existing.bundle } : {}),
      provenance: effectiveProvenance,
      // Archiving is a person's decision about whether this skill exists at
      // all, and it outlives a re-author: a redistill that happens to emit the
      // same skill again must not quietly bring it back. Only an explicit
      // `archived` on the incoming skill (the restore verb) clears it.
      ...(existing?.archived && s.archived === undefined ? { archived: true } : {}),
      // A human authoring or editing a skill takes ownership of it: the
      // flywheel must not rewrite it afterwards. Only applies to skills that
      // are actually operator-owned — a distilled skill round-tripped through
      // an operator save stays distilled and unprotected, so the next
      // redistill can still re-author it. An explicit `protected: false`
      // (an unprotect) always wins.
      ...(effectiveProvenance === 'operator' && s.protected === undefined
        ? { protected: true }
        : {}),
    });
  }

  const incomingKeys = new Set(stamped.map(identityKey));

  // Everything the incoming array did not name, that the incoming caller does
  // not own. A distilled caller owns only distilled skills; an operator caller
  // owns distilled + operator, but still never silently drops learned skills.
  const preserved: Skill[] = [];
  let replaced = 0;
  for (const existing of current) {
    const provenance = normalizeSkillProvenance(existing);
    if (incomingKeys.has(identityKey(existing))) {
      // Named by the incoming array, and not dropped by the protected guard
      // above — the incoming version replaces this one.
      replaced += 1;
      continue;
    }
    if (provenance === 'distilled') {
      // An archived skill is kept whatever the caller is. It costs a few bytes
      // in a column the runtime never reads (archived skills are filtered out
      // of every payload), and it is the only thing that makes "restore" mean
      // anything — dropping it here would turn an archive into a delete the
      // next time anyone pressed Optimize.
      if (existing.archived) {
        preserved.push(existing);
        continue;
      }
      // Unnamed distilled skill: a distilled caller is re-authoring the whole
      // distilled slice, so it goes. An operator caller is editing one skill,
      // not re-authoring the agent, so the rest of the distilled set stays.
      if (incomingProvenance === 'distilled') {
        replaced += 1;
        continue;
      }
      preserved.push(existing);
      continue;
    }
    preserved.push(existing);
  }

  // Dedup fresh distilled output against preserved learned/operator skills so
  // a redistill cannot re-create something the flywheel already owns.
  let deduped = 0;
  let accepted = stamped;
  if (!options.skipDedup && preserved.length > 0) {
    const survivors: Skill[] = [];
    for (const candidate of accepted) {
      if ((candidate.provenance ?? incomingProvenance) !== 'distilled') {
        survivors.push(candidate);
        continue;
      }
      const nearest = await findNearestSkill(
        { description: candidate.description, instruction: candidate.instruction },
        preserved.map((s) => ({
          id: s.id ?? '',
          name: s.name,
          description: s.description,
          instruction: s.instruction,
          tags: s.tags ?? [],
        })),
        { tenantId, agentId },
      );
      if (nearest && nearest.similarity >= DISTILL_DUPLICATE_THRESHOLD) {
        deduped += 1;
        log.info(
          {
            agentId,
            candidateName: candidate.name,
            matchedSkillName: nearest.matchedSkill.name,
            similarity: nearest.similarity,
          },
          'skill-provenance: dropped distilled skill duplicating a preserved skill',
        );
        continue;
      }
      survivors.push(candidate);
    }
    accepted = survivors;
  }

  const stats = {
    incoming: incoming.length,
    replaced,
    preservedLearned: preserved.filter((s) => normalizeSkillProvenance(s) === 'learned').length,
    preservedOperator: preserved.filter((s) => normalizeSkillProvenance(s) === 'operator').length,
    deduped,
  };

  // Stable identity, assigned here rather than in the runtime. `agent_skills.id`
  // is the join key for per-skill metrics and the runtime's ON CONFLICT (id)
  // reactivation: a skill that arrives without one is inserted under a freshly
  // generated id on every publish, which supersedes its own predecessor and
  // strands every metric row keyed to the old id.
  //
  // Minting happens after the key matching and the dedup pass above, both of
  // which run on the original identity keys — assigning ids earlier would move a
  // name-keyed skill to an id key mid-comparison.
  const withIds = (list: Skill[]): Skill[] =>
    list.map((s) => (s.id ? s : { ...s, id: randomUUID() }));

  return { skills: [...withIds(accepted), ...withIds(preserved)], stats };
}

/**
 * Skills as the runtime should see them: archived skills are filtered out so
 * the runtime's supersede-then-insert drops them from the active set, while the
 * platform column keeps them for restore.
 */
export function skillsForRuntime<T extends { archived?: boolean }>(skills: T[]): T[] {
  return skills.filter((s) => !s.archived);
}
