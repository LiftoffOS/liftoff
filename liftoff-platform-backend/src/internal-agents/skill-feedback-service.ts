// Skill Feedback Service
//
// Processes structured feedback from the reflection service after each agent
// task completion. Two things happen on every call:
//
//   1. Metrics update — success/failure/HITL counters are written to
//      agent_skill_metrics (one row per agent+skill, upserted atomically).
//
//   2. Skill mutation (when reflection generates a refinement or new pitfall) —
//      platform backend fetches the current skills list from the tenant runtime,
//      applies the change, then re-publishes tenant.internal_agent.skills_updated
//      so the runtime re-ingests the updated set. last_refined_at is set only
//      after confirmed publish success. Capability embedding is regenerated
//      fire-and-forget so find_teammates stays current.
//
// Called via POST /api/internal/platform-tools/skill-feedback.
// Auth: PLATFORM_CALLBACK_TOKEN (same as all platform-tools endpoints).

import { randomUUID } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { toScopeKey } from '../common/scope-key';
import { publishEvent } from './events';
import { findNearestSkill, pairCosine } from './skill-similarity';
import { mergeSkills } from './skill-merge';
import { skillsForRuntime } from './skill-provenance';
import { screenPersistedStructure } from '../injection-detection/gating';
import type { SkillProvenance } from './types';

// Dedup feature flags + thresholds.
//
// SKILL_DEDUP_ENABLED is read once at module load. When 'true', every
// newPitfallSkill candidate passes through findNearestSkill → MERGE / REFUSE /
// APPEND. When unset or any other value, behavior matches today's append-only
// path — no embed calls, no merge LLM calls, no skill_dedup_events writes
// other than recording the decision='appended'.
//
// SKILL_DEDUP_MERGE_THRESHOLD / SKILL_DEDUP_FLOOR_THRESHOLD are produced by
// scripts/calibrate-skill-dedup-thresholds.ts + scripts/pick-skill-dedup-thresholds.ts.
// They are REQUIRED at startup when SKILL_DEDUP_ENABLED='true' — the module
// throws if either is missing, which fails the Cloud Run health check and
// prevents shipping the dedup logic without calibration.
//
// Env vars are owned by Terraform (terraform/modules/platform-backend) per
// the cloudbuild.yaml deploy step's "Image-only deploy" comment. To enable
// the feature: set SKILL_DEDUP_ENABLED=true plus the two threshold vars in
// the platform-backend module's env_vars block and apply.
const SKILL_DEDUP_ENABLED = process.env.SKILL_DEDUP_ENABLED === 'true';

function requiredFloatEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `${name} env var is required when SKILL_DEDUP_ENABLED=true (run scripts/calibrate-skill-dedup-thresholds.ts)`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name}=${raw} is not a valid cosine value in [0,1]`);
  }
  return n;
}

const HIGH_MERGE_THRESHOLD = SKILL_DEDUP_ENABLED
  ? requiredFloatEnv('SKILL_DEDUP_MERGE_THRESHOLD')
  : 0;
const DEDUP_FLOOR = SKILL_DEDUP_ENABLED
  ? requiredFloatEnv('SKILL_DEDUP_FLOOR_THRESHOLD')
  : 0;
const MERGE_VERIFY_FLOOR = 0.85;
const MAX_MERGES_PER_TASK = 5;


if (SKILL_DEDUP_ENABLED && HIGH_MERGE_THRESHOLD <= DEDUP_FLOOR) {
  throw new Error(
    `SKILL_DEDUP_MERGE_THRESHOLD (${HIGH_MERGE_THRESHOLD}) must be greater than SKILL_DEDUP_FLOOR_THRESHOLD (${DEDUP_FLOOR})`,
  );
}

export interface SkillFeedbackEntry {
  skillId: string;
  skillName: string;
  outcome: 'success' | 'failure' | 'hitl_approved' | 'hitl_rejected';
  refinedInstruction?: string;
  refinedDescription?: string;
  newPitfallSkill?: {
    name: string;
    description: string;
    instruction: string;
    tags?: string[];
  };
}

export interface SkillFeedbackInput {
  tenantId: string;
  agentId: string;
  taskId?: string;
  feedback: SkillFeedbackEntry[];
}

interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  instruction: string;
  tags: string[];
  /** P1.0. Flywheel-authored skills are 'learned'; anything a human authored,
   *  edited, or imported is 'operator' and is off-limits to this service when
   *  `protected` is set. Absent on legacy rows (treated as 'distilled'). */
  provenance?: SkillProvenance;
  protected?: boolean;
  archived?: boolean;
}

/** A protected skill may not be refined or merged into by the flywheel: a human
 *  took ownership of it, and no human is present here to consent to a rewrite.
 *  Mirrors the dedup-decision logging so refusals are auditable. */
function isProtected(skill: RuntimeSkill): boolean {
  return skill.protected === true;
}

export async function processSkillFeedback(input: SkillFeedbackInput): Promise<void> {
  const { tenantId, agentId, taskId, feedback } = input;
  if (feedback.length === 0) return;

  const upsertResult = await withTenantScope(tenantId, async (client) => {
    // 1. Idempotency check — insert into skill_feedback_log.
    //    ON CONFLICT = already processed this task, skip entirely.
    if (taskId) {
      const idempotencyResult = await client.query(
        `INSERT INTO skill_feedback_log (agent_id, tenant_id, task_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, task_id) DO NOTHING
         RETURNING agent_id`,
        [agentId, tenantId, taskId],
      );
      if (idempotencyResult.rows.length === 0) {
        return { duplicate: true as const };
      }
    }

    // 2. Upsert per-skill metric rows (atomic, individual row per skill).
    for (const entry of feedback) {
      // `skill_id` is TEXT and the conflict target is (agent_id, skill_id), so an
      // empty id is a legal key: every skill without one would share a single row
      // and pool its counters. Drop the entry instead — a metric that cannot name
      // its skill is worse than a missing metric.
      if (!entry.skillId?.trim()) {
        log.warn(
          { agentId, tenantId, skillName: entry.skillName },
          'skill-feedback: dropping entry with empty skillId',
        );
        continue;
      }
      await client.query(
        `INSERT INTO agent_skill_metrics
           (agent_id, tenant_id, skill_id, skill_name, last_used_at,
            success_count, failure_count, hitl_approval_count, hitl_rejection_count)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8)
         ON CONFLICT (agent_id, skill_id) DO UPDATE SET
           skill_name           = CASE WHEN EXCLUDED.skill_name <> '' THEN EXCLUDED.skill_name ELSE agent_skill_metrics.skill_name END,
           last_used_at         = NOW(),
           success_count        = agent_skill_metrics.success_count + EXCLUDED.success_count,
           failure_count        = agent_skill_metrics.failure_count + EXCLUDED.failure_count,
           hitl_approval_count  = agent_skill_metrics.hitl_approval_count + EXCLUDED.hitl_approval_count,
           hitl_rejection_count = agent_skill_metrics.hitl_rejection_count + EXCLUDED.hitl_rejection_count,
           updated_at           = NOW()`,
        [
          agentId, tenantId, entry.skillId, entry.skillName,
          entry.outcome === 'success'       ? 1 : 0,
          entry.outcome === 'failure'       ? 1 : 0,
          entry.outcome === 'hitl_approved' ? 1 : 0,
          entry.outcome === 'hitl_rejected' ? 1 : 0,
        ],
      );
    }

    return { duplicate: false as const };
  });

  if (upsertResult.duplicate) {
    log.info({ agentId, taskId }, 'skill-feedback: duplicate task, skipping');
    return;
  }

  log.info({ agentId, tenantId, taskId, skillCount: feedback.length }, 'skill-feedback: metrics updated');

  // 3. Check for LLM-driven mutations (only present when reflection service is the caller).
  const mutations = feedback.filter(e => e.refinedInstruction || e.refinedDescription || e.newPitfallSkill);
  if (mutations.length === 0) return;

  // 4. Fetch agent: need current_version for event publishing + role for role-layer memories.
  //    `skills` comes along for the write-back below: the runtime cannot see
  //    ARCHIVED skills (they are filtered out of every payload it receives), so
  //    the authoritative column is the only place they still exist.
  const agentRow = await withTenantScope(tenantId, async (client) => {
    const result = await client.query<{ current_version: number; role: string; skills: RuntimeSkill[] | null }>(
      `SELECT current_version, role, skills FROM internal_agents
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    return result.rows[0] ?? null;
  });
  if (!agentRow) {
    log.warn({ agentId }, 'skill-feedback: agent not found for mutation, skipping');
    return;
  }
  const { current_version: entityVersion, role: agentRole } = agentRow;
  const columnSkills: RuntimeSkill[] = Array.isArray(agentRow.skills) ? agentRow.skills : [];

  // 5. Fetch current skills from tenant runtime.
  let currentSkills: RuntimeSkill[];
  try {
    const result = await tenantRuntimeClient.getAgentSkills(tenantId, agentId);
    currentSkills = result.skills;
  } catch (err) {
    log.error({ error: (err as Error).message, agentId }, 'skill-feedback: failed to fetch runtime skills, skipping mutation');
    return;
  }

  // Provenance, protection and archive state are the COLUMN's to state, not the
  // runtime's — ADR-043 makes the column authoritative. So for a skill the
  // column already knows, the COLUMN WINS OUTRIGHT. The runtime's value is a
  // fallback only for a skill the column has never seen.
  //
  // The precedence is the whole point, and getting it backwards is not a
  // theoretical risk — it was the shipped behaviour until this line changed.
  // `s.provenance ?? stored.provenance` reads as a sensible defence against the
  // runtime omitting the field, and it was, while the runtime omitted it. Now
  // that TR returns both columns and both are NOT NULL, the runtime's value is
  // ALWAYS present, so the column's was never consulted for any skill in both
  // stores.
  //
  // That matters because disagreement is the standing state, not an edge case:
  // TR's migration 334 defaulted every pre-existing row to 'distilled' and
  // nothing backfills it to 'learned'. So for every flywheel-authored skill
  // older than that migration the column says `learned` and the runtime says
  // `distilled`, and the loss chain runs: reflection mutates anything → the
  // flywheel adopts the runtime's `distilled` → the write-back down-stamps the
  // column → the next redistill deletes the skill as replaceable output.
  //
  // `protected` carries the identical hazard and is fixed the same way: a
  // runtime row defaulted to `false` would otherwise unprotect a skill an
  // operator took ownership of, defeating the enforcement entirely.
  const storedById = new Map(columnSkills.filter((s) => s.id).map((s) => [s.id as string, s]));
  const storedByName = new Map(columnSkills.map((s) => [s.name.trim().toLowerCase(), s]));
  const currentSkillsWithProvenance: RuntimeSkill[] = currentSkills.map((s) => {
    const stored = (s.id ? storedById.get(s.id) : undefined)
      ?? storedByName.get(s.name.trim().toLowerCase());
    if (!stored) return s;
    return {
      ...s,
      provenance: stored.provenance ?? s.provenance,
      protected: stored.protected ?? s.protected,
      // Archived lives ONLY in the column — it is filtered out of every runtime
      // payload — so the runtime can never have an opinion to prefer.
      archived: stored.archived ?? s.archived,
    };
  });

  let updatedSkills = [...currentSkillsWithProvenance];

  // Buffer of dedup decisions. Written to skill_dedup_events AFTER publish
  // succeeds — matches the deferred-write pattern used for last_refined_at
  // so both telemetry tables stay consistent under whatever outbox behavior
  // obtains.
  const dedupEvents: Array<{
    candidateName: string;
    candidateRoleWide: boolean;
    originatingSkillId: string | null;
    decision: 'appended' | 'refused' | 'merged';
    matchedSkillId: string | null;
    similarityScore: number | null;
  }> = [];

  // Skills whose content actually changed in this run (refinements + merge
  // targets). Used to bump last_refined_at on the right rows — a merge
  // changes nearest.matchedSkill.id, NOT mutation.skillId.
  const modifiedSkillIds = new Set<string>();

  // Bounds total merge LLM calls per task. A buggy reflection that produces
  // many high-similarity candidates would otherwise fire one large-tier
  // LLM call per candidate.
  let mergesThisTask = 0;

  for (const mutation of mutations) {
    // Refinements run before pitfall candidates within a single mutation
    // entry. If a task contains both a refinement of X and a candidate that
    // would merge into X, the refinement applies first, then the candidate
    // compares against the post-refinement X. Correct order — refinements
    // should land before merges see them.
    if (mutation.refinedInstruction || mutation.refinedDescription) {
      const target = updatedSkills.find(
        s => s.id === mutation.skillId || s.name === mutation.skillName,
      );
      if (target && isProtected(target)) {
        // Operator-owned skill: drop the refinement rather than overwrite a
        // human's edit. Only the refinement is dropped — a pitfall candidate
        // on the same mutation still goes through the dedup path below.
        log.info(
          { agentId, skillId: target.id, skillName: target.name },
          'skill-feedback: refinement dropped — skill is operator-protected',
        );
      } else {
        updatedSkills = updatedSkills.map(s => {
          if (s.id === mutation.skillId || s.name === mutation.skillName) {
            return {
              ...s,
              ...(mutation.refinedInstruction ? { instruction: mutation.refinedInstruction } : {}),
              ...(mutation.refinedDescription ? { description: mutation.refinedDescription } : {}),
            };
          }
          return s;
        });
        log.info({ agentId, skillId: mutation.skillId }, 'skill-feedback: skill mutation staged');
      }
    }

    if (mutation.newPitfallSkill) {
      const candidate = mutation.newPitfallSkill;

      // E2: the flywheel authors a permanent instruction from material that
      // originated in tool output — vendor API responses, fetched pages, other
      // people's messages. That is an injection path straight into durable
      // agent behaviour, and unlike a chat message nobody reviews it later.
      // Screened here, before the candidate can reach the merge.
      const skillScreen = await screenPersistedStructure('skill', candidate, { tenantId, agentId });
      if (skillScreen.block) {
        log.warn(
          { agentId, skillName: candidate.name },
          'skill-feedback: new skill refused — content was flagged by injection screening',
        );
        continue;
      }

      const candidateTags = candidate.tags ?? [];
      const candidateIsRoleWide = candidateTags.includes('role-wide');

      // Name-exact short-circuit — cheaper than embedding.
      const nameExists = updatedSkills.some(s => s.name === candidate.name);
      if (nameExists) {
        dedupEvents.push({
          candidateName: candidate.name,
          candidateRoleWide: candidateIsRoleWide,
          originatingSkillId: mutation.skillId || null,
          decision: 'refused',
          matchedSkillId: null,
          similarityScore: 1.0,
        });
        continue;
      }

      // Kill switch off → today's append-only behavior. Deliberately does NOT
      // write a skill_dedup_events row: with the feature off we never embed,
      // so we don't know what the cosine WOULD have been. A row with
      // similarity_score=null is noise — the dedup_events table is for
      // recorded dedup DECISIONS, not for "I would have decided if turned on."
      // skills[] additions are already visible in the existing log line.
      if (!SKILL_DEDUP_ENABLED) {
        updatedSkills.push(buildNewSkill(candidate, mutation.skillId));
        log.info({ agentId, skillName: candidate.name }, 'skill-feedback: pitfall skill staged (dedup disabled)');
        continue;
      }

      // Role-wide / individual boundary: never compare or merge across it.
      // Role-wide skills are shared infrastructure; an individual-agent
      // pitfall must not merge into one (and vice versa).
      // Protected skills are excluded from the comparison set entirely, so a
      // candidate can never MERGE into one (which would rewrite a human's
      // skill). It may still be REFUSED against an unprotected near-duplicate.
      const comparable = updatedSkills.filter(s =>
        s.tags.includes('role-wide') === candidateIsRoleWide && !isProtected(s),
      );

      const nearest = await findNearestSkill(candidate, comparable, { tenantId, agentId });

      // Over the merge cap on a candidate that would otherwise have merged:
      // APPEND rather than REFUSE. Preserves the reflection signal at the
      // cost of one duplicate skill that the next dedup pass can revisit.
      if (nearest && nearest.similarity >= HIGH_MERGE_THRESHOLD && mergesThisTask >= MAX_MERGES_PER_TASK) {
        updatedSkills.push(buildNewSkill(candidate, mutation.skillId));
        dedupEvents.push({
          candidateName: candidate.name,
          candidateRoleWide: candidateIsRoleWide,
          originatingSkillId: mutation.skillId || null,
          decision: 'appended',
          matchedSkillId: null,
          similarityScore: nearest.similarity,
        });
        log.info(
          { agentId, similarity: nearest.similarity, mergesThisTask },
          'skill-feedback: pitfall appended (merge cap reached)',
        );
        continue;
      }

      if (nearest && nearest.similarity >= HIGH_MERGE_THRESHOLD) {
        // MERGE branch.
        mergesThisTask += 1;

        const merged = await mergeSkills(
          nearest.matchedSkill,
          { ...candidate, tags: candidateTags },
          { tenantId, agentId, agentRole },
        );

        if (merged) {
          // Verify the merged skill stays semantically close to BOTH inputs.
          // pairCosine returning null means embed failed — accept the merge
          // rather than reject on infra error.
          const [verifyA, verifyB] = await Promise.all([
            pairCosine(nearest.matchedSkill, merged, { tenantId, agentId }),
            pairCosine(candidate, merged, { tenantId, agentId }),
          ]);
          const passesVerification =
            (verifyA === null || verifyA >= MERGE_VERIFY_FLOOR) &&
            (verifyB === null || verifyB >= MERGE_VERIFY_FLOOR);

          if (passesVerification) {
            const targetSkillId = nearest.matchedSkill.id;
            updatedSkills = updatedSkills.map(s =>
              s.id === targetSkillId
                ? { ...s, name: merged.name, description: merged.description, instruction: merged.instruction, tags: merged.tags }
                : s,
            );
            modifiedSkillIds.add(targetSkillId);
            dedupEvents.push({
              candidateName: candidate.name,
              candidateRoleWide: candidateIsRoleWide,
              originatingSkillId: mutation.skillId || null,
              decision: 'merged',
              matchedSkillId: targetSkillId,
              similarityScore: nearest.similarity,
            });
            log.info(
              { agentId, mergedInto: targetSkillId, similarity: nearest.similarity, verifyA, verifyB },
              'skill-feedback: pitfall merged into existing skill',
            );
            continue;
          }

          log.warn(
            { agentId, verifyA, verifyB, floor: MERGE_VERIFY_FLOOR },
            'skill-feedback: merge verification failed, appending candidate as new skill',
          );
        } else {
          log.warn({ agentId }, 'skill-feedback: merge LLM returned null, appending candidate as new skill');
        }

        // Fall through to APPEND on merge LLM failure or verification failure.
        updatedSkills.push(buildNewSkill(candidate, mutation.skillId));
        dedupEvents.push({
          candidateName: candidate.name,
          candidateRoleWide: candidateIsRoleWide,
          originatingSkillId: mutation.skillId || null,
          decision: 'appended',
          matchedSkillId: null,
          similarityScore: nearest.similarity,
        });
        continue;
      }

      if (nearest && nearest.similarity >= DEDUP_FLOOR) {
        // REFUSE branch — too similar to add, not similar enough to merge.
        dedupEvents.push({
          candidateName: candidate.name,
          candidateRoleWide: candidateIsRoleWide,
          originatingSkillId: mutation.skillId || null,
          decision: 'refused',
          matchedSkillId: nearest.matchedSkill.id,
          similarityScore: nearest.similarity,
        });
        log.info(
          { agentId, matchedSkillId: nearest.matchedSkill.id, similarity: nearest.similarity },
          'skill-feedback: pitfall refused (duplicate of existing skill)',
        );
        continue;
      }

      // APPEND branch — no close existing skill, or merge cap exhausted.
      updatedSkills.push(buildNewSkill(candidate, mutation.skillId));
      dedupEvents.push({
        candidateName: candidate.name,
        candidateRoleWide: candidateIsRoleWide,
        originatingSkillId: mutation.skillId || null,
        decision: 'appended',
        matchedSkillId: null,
        similarityScore: nearest?.similarity ?? null,
      });
      log.info({ agentId, skillName: candidate.name }, 'skill-feedback: pitfall skill staged');
    }
  }

  // 6. Publish skills_updated. Call publishEvent directly — publishInternalAgentEvent
  //    silently swallows errors, so we would never know if publish failed.
  //    last_refined_at is only set after confirmed publish success.
  const now = new Date().toISOString();
  let publishSucceeded = false;
  try {
    await publishEvent({
      entityType: 'internal_agent',
      entityId: agentId,
      eventType: 'tenant.internal_agent.skills_updated',
      entityVersion,
      eventVersion: 1,
      tenantId,
      // Archived skills are filtered on the way out (P1.4) — the runtime
      // rebuilds its active set from this payload, so an archived skill must
      // not reappear there. The write-back below keeps the full set.
      payload: { agentId, skills: skillsForRuntime(updatedSkills), updatedAt: now, source: 'reflection' },
    });
    publishSucceeded = true;
  } catch (err) {
    log.error(
      { error: (err as Error).message, agentId },
      'skill-feedback: Pub/Sub publish failed — mutations not applied; will retry on next reflection run',
    );
  }

  if (!publishSucceeded) return;

  // 6b. Write the merged set back to internal_agents.skills (P1.0).
  //
  // The platform column is the authoritative store: service.update merges
  // against it, and the `updated` envelope carries it to the runtime. Without
  // this write-back the column would still hold only the last distill output,
  // so the very next agent edit would publish a set missing every learned
  // skill — re-opening the clobber this feature exists to close.
  //
  // Deliberately a direct UPDATE rather than internalAgentService.update: a
  // flywheel mutation is not an operator edit, so it must not bump the version
  // or emit an `updated` envelope (the skills_updated event above already told
  // the runtime). Best-effort — the runtime is already consistent at this
  // point, and a failure here self-heals on the next reflection run.
  try {
    // Archived skills are invisible to the runtime by design, so `updatedSkills`
    // — which came FROM the runtime — does not contain them. Writing it back
    // verbatim would delete them from the one place they still live, and
    // "restore" (P1.4) would have nothing to restore. Carry them across.
    const known = new Set(updatedSkills.flatMap((s) => [s.id, s.name].filter(Boolean) as string[]));
    const archivedOnlyInColumn = columnSkills.filter(
      (s) => s.archived === true && !known.has(s.id ?? '') && !known.has(s.name),
    );
    const authoritative = [...updatedSkills, ...archivedOnlyInColumn];

    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE internal_agents SET skills = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
        [JSON.stringify(authoritative), agentId, tenantId],
      ),
    );
  } catch (err) {
    log.error(
      { error: (err as Error).message, agentId },
      'skill-feedback: platform-column write-back failed — runtime is updated, column will re-sync on the next run',
    );
  }

  // 7. Set last_refined_at on every skill that actually changed — refinements
  //    AND merge targets. mutations.map(m => m.skillId) only covers refinements;
  //    a merge changes nearest.matchedSkill.id, which lives in modifiedSkillIds.
  for (const m of mutations) {
    if (m.skillId) modifiedSkillIds.add(m.skillId);
  }
  if (modifiedSkillIds.size > 0) {
    const ids = Array.from(modifiedSkillIds);
    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE agent_skill_metrics
         SET last_refined_at = NOW(), origin = 'reflection', updated_at = NOW()
         WHERE agent_id = $1 AND skill_id = ANY($2::text[])`,
        [agentId, ids],
      ),
    );
  }

  // 7b. Flush buffered dedup decisions. Same post-publish position as
  //     last_refined_at so the two telemetry tables stay consistent.
  if (dedupEvents.length > 0) {
    await withTenantScope(tenantId, async (client) => {
      for (const ev of dedupEvents) {
        await client.query(
          `INSERT INTO skill_dedup_events
             (agent_id, tenant_id, task_id, candidate_name, candidate_role_wide,
              originating_skill_id, decision, matched_skill_id, similarity_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            agentId,
            tenantId,
            taskId ?? null,
            ev.candidateName,
            ev.candidateRoleWide,
            ev.originatingSkillId,
            ev.decision,
            ev.matchedSkillId,
            ev.similarityScore,
          ],
        );
      }
    });
  }

  // 8. Memory writes (fire-and-forget).
  for (const mutation of mutations) {
    const skillName = updatedSkills.find(
      s => s.id === mutation.skillId || s.name === mutation.skillName,
    )?.name ?? mutation.skillName;

    // `agentId` here is the control-plane internal_agents.id. It goes in as
    // internalAgentId so the runtime translates it into its own space — an
    // individual memory is retrieved by the runtime's agent id, so an
    // untranslated one would store a row no reader can reach. The scope key
    // is left to the runtime, which uses the translated id.
    if (mutation.refinedInstruction) {
      tenantRuntimeClient.saveMemory(tenantId, {
        layer: 'individual',
        content: `Skill '${skillName}' instruction was refined: ${mutation.refinedInstruction}`,
        internalAgentId: agentId,
        triggerType: 'skill_reflection',
        triggerRefId: `skill-refined-instruction:${mutation.skillId ?? skillName}`,
      }).catch((err: Error) => log.warn({ error: err.message }, 'skill-feedback: memory write failed (non-fatal)'));
    }
    if (mutation.refinedDescription) {
      tenantRuntimeClient.saveMemory(tenantId, {
        layer: 'individual',
        content: `Skill '${skillName}' retrieval scope narrowed: ${mutation.refinedDescription}`,
        internalAgentId: agentId,
        triggerType: 'skill_reflection',
        triggerRefId: `skill-refined-description:${mutation.skillId ?? skillName}`,
      }).catch((err: Error) => log.warn({ error: err.message }, 'skill-feedback: memory write failed (non-fatal)'));
    }
    if (mutation.newPitfallSkill) {
      tenantRuntimeClient.saveMemory(tenantId, {
        layer: 'individual',
        content: `New pitfall skill added: '${mutation.newPitfallSkill.name}' — ${mutation.newPitfallSkill.description}`,
        internalAgentId: agentId,
        triggerType: 'skill_reflection',
        triggerRefId: `skill-new-pitfall:${mutation.newPitfallSkill.name}`,
      }).catch((err: Error) => log.warn({ error: err.message }, 'skill-feedback: memory write failed (non-fatal)'));

      if (mutation.newPitfallSkill.tags?.includes('role-wide')) {
        tenantRuntimeClient.saveMemory(tenantId, {
          layer: 'role',
          scopeKey: toScopeKey(agentRole),
          content: `Role-wide pitfall for '${agentRole}': '${mutation.newPitfallSkill.name}' — ${mutation.newPitfallSkill.description}`,
          internalAgentId: agentId,
          triggerType: 'skill_reflection',
          triggerRefId: `skill-new-pitfall-role:${agentRole}:${mutation.newPitfallSkill.name}`,
        }).catch((err: Error) => log.warn({ error: err.message }, 'skill-feedback: role memory write failed (non-fatal)'));
      }
    }
  }

  // 8b. Memory writes for merge decisions. Distinct from the per-mutation
  //     memory variants because a merge collapses two skills — the audit
  //     trail should reference both the candidate that was proposed AND the
  //     post-merge target name (which may have been rewritten by the merge
  //     LLM).
  for (const ev of dedupEvents) {
    if (ev.decision === 'merged' && ev.matchedSkillId) {
      const mergedSkill = updatedSkills.find(s => s.id === ev.matchedSkillId);
      if (mergedSkill) {
        const sim = ev.similarityScore?.toFixed(3) ?? 'n/a';
        tenantRuntimeClient.saveMemory(tenantId, {
          layer: 'individual',
          content: `Reflection produced pitfall '${ev.candidateName}' which was merged into existing skill '${mergedSkill.name}' (cosine ${sim}).`,
          internalAgentId: agentId,
          triggerType: 'skill_reflection',
          triggerRefId: `skill-merged:${ev.matchedSkillId}:${ev.candidateName}`,
        }).catch((err: Error) => log.warn({ error: err.message }, 'skill-feedback: merge-memory write failed (non-fatal)'));
      }
    }
  }

  // 9. Regenerate capability embedding (fire-and-forget — skills content changed).
  import('./embedding-service').then(({ generateAndStoreEmbedding }) => {
    generateAndStoreEmbedding(agentId, tenantId).catch((err: Error) =>
      log.warn({ error: err.message, agentId }, 'skill-feedback: embedding regen failed (non-fatal)'),
    );
  }).catch(() => {});
}

function buildNewSkill(
  candidate: NonNullable<SkillFeedbackEntry['newPitfallSkill']>,
  originatingSkillId: string,
): RuntimeSkill {
  return {
    // crypto.randomUUID() avoids the Date.now() collision risk in tight
    // loops (e.g. tests, or multiple candidates from a single reflection
    // task hitting the APPEND branch in the same millisecond).
    id: `reflection:${randomUUID()}:${originatingSkillId}`,
    name: candidate.name,
    description: candidate.description,
    instruction: candidate.instruction,
    tags: candidate.tags ?? [],
    // P1.0: flywheel-authored. A redistill preserves these instead of
    // replacing them with freshly distilled output.
    provenance: 'learned',
  };
}
