// User-initiated skill imports.
//
// Two entry points feed this: a file the user attached while building a team
// member ("here are my old skills"), and a technique they taught in chat
// ("learn this"). Both are the SAME kind of write as the reflection flywheel's
// — a skill arriving outside distillation — so they ride the same rail rather
// than a parallel one:
//
//   dedup against the live set → merge into the platform column by provenance
//   → publish skills_updated → the runtime re-ingests
//
// The differences from the flywheel are deliberate and both about authorship:
// imported skills are `operator` provenance (a human chose them) and therefore
// `protected` (the flywheel may not silently rewrite what a person imported).
//
// Dedup here is name-and-similarity based and REFUSES rather than merges: a
// merge would rewrite the user's own wording with an LLM's paraphrase, which is
// the wrong default for material they explicitly handed us.

import crypto from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { screenPersistedStructure } from '../injection-detection/gating';
import { storeSkillBundle, type BundleFileInput } from './skill-bundle';
import { scanImportedSkill, shouldQuarantine, type SupplyChainFinding } from './skill-supply-chain';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { publishEvent } from './events';
import { findNearestSkill } from './skill-similarity';
import { skillsForRuntime } from './skill-provenance';
import type { Skill, SkillBundle } from './types';

/** Similarity at or above which an imported skill is considered already
 *  present. Matches the provenance-merge threshold so the two paths agree on
 *  what "the same skill" means. */
const IMPORT_DUPLICATE_THRESHOLD = 0.92;

export interface ImportedSkillInput {
  name: string;
  description: string;
  instruction: string;
  tags?: string[];
  /** The skill's own files — `scripts/`, `references/`, `examples/`. Text only;
   *  see skill-bundle.ts for why, and for the caps. */
  files?: BundleFileInput[];
}

export interface ApplyImportedSkillsResult {
  imported: number;
  skippedAsDuplicate: number;
  /** Refused by injection screening OR the supply-chain scan — counted
   *  separately from duplicates so the caller can tell "you already have this"
   *  from "this was rejected". */
  refusedByScreening: number;
  /** What the supply-chain scan refused, and why. Surfaced rather than
   *  swallowed — a person watching a file disappear from their import learns
   *  nothing, and the reason is the whole value of the check. */
  quarantined: Array<{ name: string; findings: SupplyChainFinding[] }>;
}

/**
 * Add user-supplied skills to an agent. Idempotent in practice: re-importing
 * the same file refuses every skill as a duplicate rather than piling up
 * near-identical entries.
 */
export async function applyImportedSkills(
  tenantId: string,
  agentId: string,
  incoming: ImportedSkillInput[],
): Promise<ApplyImportedSkillsResult> {
  if (incoming.length === 0) return { imported: 0, skippedAsDuplicate: 0, refusedByScreening: 0, quarantined: [] };

  // The live set is the runtime's, for the same reason the flywheel reads it
  // there: it is what the agent is actually running with right now.
  let currentSkills: Skill[];
  try {
    const result = await tenantRuntimeClient.getAgentSkills(tenantId, agentId);
    currentSkills = result.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      instruction: s.instruction,
      tags: s.tags ?? [],
    }));
  } catch (err) {
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      'skill-import: could not read the live skill set — skipping import',
    );
    return { imported: 0, skippedAsDuplicate: 0, refusedByScreening: 0, quarantined: [] };
  }

  // Provenance for skills the runtime already holds comes from the platform
  // column, which the provenance merge keeps authoritative. Without this the merge below would
  // treat every pre-existing skill as distilled and mislabel it on write-back.
  const stored = await withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ skills: Skill[] }>(
      `SELECT skills FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    return res.rows[0]?.skills ?? [];
  });
  const provenanceById = new Map(stored.filter((s) => s.id).map((s) => [s.id!, s]));
  const provenanceByName = new Map(stored.map((s) => [s.name.trim().toLowerCase(), s]));

  const merged: Skill[] = currentSkills.map((s) => {
    const known = (s.id ? provenanceById.get(s.id) : undefined)
      ?? provenanceByName.get(s.name.trim().toLowerCase());
    return {
      ...s,
      provenance: known?.provenance ?? 'distilled',
      ...(known?.protected !== undefined ? { protected: known.protected } : {}),
      ...(known?.archived !== undefined ? { archived: known.archived } : {}),
      // Bundles live only in the platform column — the runtime is sent pointers
      // it resolves, and `currentSkills` is built from the runtime's view. Not
      // carrying them across here would make every skill import silently strip
      // the files off every OTHER skill the agent already had.
      ...(known?.bundle ? { bundle: known.bundle } : {}),
    };
  });

  let imported = 0;
  let skippedAsDuplicate = 0;
  let refusedByScreening = 0;
  const quarantined: Array<{ name: string; findings: SupplyChainFinding[] }> = [];

  for (const candidate of incoming) {
    // Persistence-path injection screening. A skill is the highest-value target in the
    // system: it is retrieved into the prompt on future runs, so a poisoned one
    // keeps working long after the file that carried it is forgotten.
    const screen = await screenPersistedStructure('skill', candidate, { tenantId, agentId });
    if (screen.block) {
      refusedByScreening += 1;
      log.warn(
        { tenantId, agentId, skillName: candidate.name },
        'skill-import: refused — content was flagged by injection screening',
      );
      continue;
    }

    // Supply-chain scan. The screen above asks "is this hijacking the
    // current turn"; this asks the different question a permanent instruction
    // deserves — does it tell the team member to exfiltrate, read credentials,
    // or survive review? Quarantined with the reason rather than dropped, so
    // the person can see what was refused instead of watching a file vanish.
    const findings = scanImportedSkill(candidate);
    if (shouldQuarantine('imported', findings)) {
      refusedByScreening += 1;
      quarantined.push({ name: candidate.name, findings });
      log.warn(
        {
          tenantId, agentId, skillName: candidate.name,
          categories: [...new Set(findings.map((f) => f.category))],
          rules: findings.map((f) => f.rule),
        },
        'skill-import: quarantined — the instruction asks for something a skill has no business doing',
      );
      continue;
    }

    const nameTaken = merged.some(
      (s) => s.name.trim().toLowerCase() === candidate.name.trim().toLowerCase(),
    );
    if (nameTaken) {
      skippedAsDuplicate += 1;
      log.info({ tenantId, agentId, skillName: candidate.name }, 'skill-import: refused — name already present');
      continue;
    }

    const nearest = await findNearestSkill(
      { description: candidate.description, instruction: candidate.instruction },
      merged.map((s) => ({
        id: s.id ?? '',
        name: s.name,
        description: s.description,
        instruction: s.instruction,
        tags: s.tags ?? [],
      })),
      { tenantId, agentId },
    );
    if (nearest && nearest.similarity >= IMPORT_DUPLICATE_THRESHOLD) {
      skippedAsDuplicate += 1;
      log.info(
        { tenantId, agentId, skillName: candidate.name, matched: nearest.matchedSkill.name, similarity: nearest.similarity },
        'skill-import: refused — near-duplicate of an existing skill',
      );
      continue;
    }

    // The skill's files are stored before the skill is, so a skill is never
    // written claiming a bundle that does not exist. The id is minted here
    // rather than downstream because it is the storage key: content lives at
    // skill-bundles/{tenant}/{skillId}/{sha256}, and a skill with no id yet has
    // nowhere to put it.
    const skillId = crypto.randomUUID();
    let bundle: SkillBundle | undefined;
    if (candidate.files?.length) {
      const stored = await storeSkillBundle(tenantId, skillId, candidate.files);
      bundle = stored.bundle ?? undefined;
      if (stored.rejected.length > 0) {
        log.warn(
          {
            tenantId,
            agentId,
            skillName: candidate.name,
            rejected: stored.rejected,
          },
          'skill-import: some files were not stored; the skill imports without them',
        );
      }
    }

    merged.push({
      id: skillId,
      name: candidate.name,
      description: candidate.description,
      instruction: candidate.instruction,
      tags: candidate.tags ?? [],
      // A human chose this: operator-owned, and protected from flywheel
      // rewrites until they say otherwise.
      provenance: 'operator',
      protected: true,
      ...(bundle ? { bundle } : {}),
    });
    imported += 1;
  }

  if (imported === 0) {
    return { imported, skippedAsDuplicate, refusedByScreening, quarantined };
  }

  // Publish first, then write back — same ordering the flywheel uses, so a
  // publish failure never leaves the platform column claiming skills the
  // runtime does not have.
  const agentRow = await withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ current_version: number }>(
      `SELECT current_version FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    return res.rows[0] ?? null;
  });
  if (!agentRow) {
    log.warn({ tenantId, agentId }, 'skill-import: agent not found — nothing published');
    return { imported: 0, skippedAsDuplicate, refusedByScreening, quarantined };
  }

  try {
    await publishEvent({
      entityType: 'internal_agent',
      entityId: agentId,
      eventType: 'tenant.internal_agent.skills_updated',
      entityVersion: agentRow.current_version,
      eventVersion: 1,
      tenantId,
      payload: {
        agentId,
        skills: skillsForRuntime(merged),
        updatedAt: new Date().toISOString(),
        source: 'import',
      },
    });
  } catch (err) {
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      'skill-import: publish failed — imported skills not applied',
    );
    return { imported: 0, skippedAsDuplicate, refusedByScreening, quarantined };
  }

  try {
    // Archived skills live ONLY in the column — they are filtered out of every
    // payload the runtime receives, so `merged` (built from the runtime's active
    // set) cannot contain them. Writing it back verbatim would delete them, and
    // Restore would have nothing to restore. Same carry-across the flywheel
    // write-back does.
    const known = new Set(merged.flatMap((s) => [s.id, s.name].filter(Boolean) as string[]));
    const archivedOnlyInColumn = stored.filter(
      (s) => s.archived === true && !known.has(s.id ?? '') && !known.has(s.name),
    );
    const authoritative = [...merged, ...archivedOnlyInColumn];

    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE internal_agents SET skills = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
        [JSON.stringify(authoritative), agentId, tenantId],
      ),
    );
  } catch (err) {
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      'skill-import: platform-column write-back failed — runtime updated, column re-syncs on the next flywheel run',
    );
  }

  log.info({ tenantId, agentId, imported, skippedAsDuplicate, refusedByScreening }, 'skill-import: complete');
  return { imported, skippedAsDuplicate, refusedByScreening, quarantined };
}
