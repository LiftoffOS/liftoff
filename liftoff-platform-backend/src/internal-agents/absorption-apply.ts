// Absorption apply — land the classified artifacts in their homes (P1.1).
//
// Runs AFTER the agent row exists, because every destination is keyed on the
// agent: skills go through the skill rail, memories through the runtime's
// memory store, and approved reference documents into the workspace knowledge
// library.
//
// Everything here is best-effort and individually guarded. An import that
// half-lands is recoverable — the user can see what arrived on the settings
// page and re-share what did not — whereas an import that fails the whole
// create leaves them with no team member at all.
//
// The consent split is enforced here, not in the classifier:
//   * skills + individual memories  → applied immediately (agent-scoped)
//   * knowledge library             → only for names the user approved
//   * workspace-scoped memories     → NOT written; surfaced for a later ask,
//                                     because the global layer is shared
//                                     context and nobody consented to it.

import { log } from '../infrastructure/logging';
import { screenPersistedContent } from '../injection-detection/gating';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import * as knowledgeService from '../knowledge/service';
import * as knowledgeRepo from '../knowledge/repository';
import { applyImportedSkills } from './skill-import-service';
import type { ArtifactClassification } from './absorption-service';
import type { TeamAttachment } from './types';

export interface AbsorptionApplySummary {
  skillsImported: number;
  memoriesImported: number;
  knowledgeItemsCreated: number;
  /** A document the library already held under the same name. */
  knowledgeItemsSkippedAsDuplicate: number;
  /** A document the library already held under a DIFFERENT name, refreshed in
   *  place rather than twinned. */
  knowledgeItemsUpdated: number;
  workspaceMemoriesDeferred: number;
}

/** Fast path for the common re-import: the same document under the same name.
 *  Cheap, and catches most of it. Content similarity below catches the rest. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\.(md|txt|pdf|docx?)$/i, '').replace(/[\s_-]+/g, ' ');
}

/** pgvector cosine distance at or below which two documents are the same
 *  document. Deliberately tight: the cost of a false positive is overwriting a
 *  real library entry with a different document, which is much worse than the
 *  cost of a twin. */
const KNOWLEDGE_DUPLICATE_MAX_DISTANCE = 0.08;

/**
 * Is this document already in the library, by content rather than by name?
 *
 * Only items that have been embedded are comparable — extraction and embedding
 * run asynchronously after import — so this is a supplement to the title check,
 * never a replacement for it. Returns null on any failure: dedup is a quality
 * measure, and failing it should mean "create the item", not "lose the import".
 */
async function findContentDuplicate(
  tenantId: string,
  agentId: string,
  text: string,
): Promise<{ id: string; title: string } | null> {
  const trimmed = text.trim();
  // Too short to be a meaningful embedding comparison; the title check owns
  // this case.
  if (trimmed.length < 200) return null;
  try {
    const { embedQuery } = await import('../knowledge/embedding-service');
    const embedding = await embedQuery(trimmed, { tenantId, agentId });
    if (!embedding) return null;
    const nearest = await knowledgeRepo.findNearestByEmbedding(
      tenantId,
      embedding,
      KNOWLEDGE_DUPLICATE_MAX_DISTANCE,
    );
    return nearest ? { id: nearest.id, title: nearest.title } : null;
  } catch (err) {
    log.warn(
      { tenantId, error: (err as Error).message },
      'absorption-apply: content dedup unavailable — falling back to the title check alone',
    );
    return null;
  }
}

export async function applyAbsorption(params: {
  tenantId: string;
  agentId: string;
  classifications: ArtifactClassification[];
  /** Artifact names the user approved for the shared knowledge library. */
  libraryApprovals?: string[];
  /** The attachments the artifacts came from. Uploads carry their text inline;
   *  connector attachments carry a file reference, which the knowledge module
   *  extracts natively — so a document imported from a drive lands in the
   *  library as a live, re-extractable item rather than a flattened copy. */
  attachments: TeamAttachment[];
}): Promise<AbsorptionApplySummary> {
  const { tenantId, agentId, classifications, attachments } = params;
  const attachmentByName = new Map(attachments.map((a) => [a.name, a]));
  const approvals = new Set(params.libraryApprovals ?? []);

  const summary: AbsorptionApplySummary = {
    skillsImported: 0,
    memoriesImported: 0,
    knowledgeItemsCreated: 0,
    knowledgeItemsSkippedAsDuplicate: 0,
    knowledgeItemsUpdated: 0,
    workspaceMemoriesDeferred: 0,
  };

  // ── Skills ────────────────────────────────────────────────────────────
  const skills = classifications.flatMap((c) => c.skills ?? []);
  if (skills.length > 0) {
    try {
      const applied = await applyImportedSkills(tenantId, agentId, skills);
      summary.skillsImported = applied.imported;
    } catch (err) {
      log.error(
        { tenantId, agentId, error: (err as Error).message },
        'absorption-apply: skill import failed',
      );
    }
  }

  // ── Memories ──────────────────────────────────────────────────────────
  for (const classification of classifications) {
    for (const memory of classification.memories ?? []) {
      if (memory.scope === 'workspace') {
        // Shared scope: needs the same explicit consent the library needs, and
        // there is no surface for that yet. Counted so the summary can say so
        // rather than the fact silently disappearing.
        summary.workspaceMemoriesDeferred += 1;
        continue;
      }
      try {
        // E2: imported memory is user-supplied file content that will be
        // retrieved back into prompts later, so it gets the same screening the
        // knowledge item from this very import gets. Screening one and not the
        // other would leave the cheaper path open.
        const memScreen = await screenPersistedContent('memory', memory.content, {
          tenantId,
          agentId,
        });
        if (memScreen.block) {
          log.warn(
            { tenantId, agentId, source: classification.name },
            'absorption-apply: memory refused — content was flagged by injection screening',
          );
          continue;
        }
        // saveAgentMemory never throws (circuit-breaker fallback), so a failure
        // here shows up as an empty memoryId rather than an exception.
        const result = await tenantRuntimeClient.saveAgentMemory(
          tenantId,
          agentId,
          'individual',
          memory.content,
          ['type:imported', `source:${classification.name}`],
        );
        if (result.memoryId) summary.memoriesImported += 1;
      } catch (err) {
        log.warn(
          { tenantId, agentId, error: (err as Error).message },
          'absorption-apply: memory import failed',
        );
      }
    }
  }

  // ── Knowledge library (consented only) ────────────────────────────────
  const referenceCandidates = classifications.filter(
    (c) => c.category === 'reference' && approvals.has(c.name),
  );
  if (referenceCandidates.length > 0) {
    let existingTitles = new Set<string>();
    try {
      const existing = await knowledgeRepo.listByTenant(tenantId);
      existingTitles = new Set(existing.map((i) => normalizeTitle(i.title)));
    } catch (err) {
      log.warn(
        { tenantId, error: (err as Error).message },
        'absorption-apply: could not list knowledge items for dedup — proceeding without it',
      );
    }

    for (const candidate of referenceCandidates) {
      const title = candidate.referenceTitle || candidate.name;
      if (existingTitles.has(normalizeTitle(title))) {
        // The library already holds this document. Never create a twin: a
        // duplicated help centre is worse than a stale one.
        summary.knowledgeItemsSkippedAsDuplicate += 1;
        log.info(
          { tenantId, title },
          'absorption-apply: knowledge item skipped — the library already holds this title',
        );
        continue;
      }
      try {
        const attachment = attachmentByName.get(candidate.name);
        // E2: the knowledge library is workspace-shared and retrieved by every
        // team member, so a poisoned document reaches agents that never saw the
        // import.
        const screen = await screenPersistedContent(
          'knowledge_item',
          attachment?.kind === 'upload' ? attachment.content.slice(0, 20000) : title,
          { tenantId, agentId },
        );
        if (screen.block) {
          log.warn(
            { tenantId, title },
            'absorption-apply: knowledge item refused — content was flagged by injection screening',
          );
          continue;
        }
        // Same document under a different name: refresh what the library holds
        // instead of standing a twin next to it. Re-running extraction is the
        // point — an import is usually a NEWER copy than what is on file.
        const uploadText = attachment?.kind === 'upload' ? attachment.content : '';
        const contentDuplicate = uploadText
          ? await findContentDuplicate(tenantId, agentId, uploadText)
          : null;
        if (contentDuplicate) {
          await knowledgeRepo.update(contentDuplicate.id, tenantId, {
            excerpt: uploadText.slice(0, 4000),
            metadata: { importedFrom: candidate.name, importedByAgentId: agentId },
          });
          await knowledgeRepo.updateMetadataField(tenantId, contentDuplicate.id, 'reimportedAt', new Date().toISOString());
          summary.knowledgeItemsUpdated += 1;
          log.info(
            { tenantId, title, matchedItemId: contentDuplicate.id, matchedTitle: contentDuplicate.title },
            'absorption-apply: knowledge item refreshed — the library already held this document under another name',
          );
          continue;
        }

        await knowledgeService.createItem(tenantId, {
          title,
          contentType: 'document',
          // An uploaded file carries its text with it. A connector file keeps
          // its provider reference instead, so the knowledge module's own
          // extractor fetches it — the item then stays re-extractable rather
          // than frozen at import time.
          ...(attachment?.kind === 'upload'
            ? { excerpt: attachment.content.slice(0, 4000) }
            : attachment?.kind === 'connector'
              ? {
                  connectorId: attachment.connectorId,
                  connectorType: attachment.connectorType,
                  externalId: attachment.externalId,
                  ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
                }
              : {}),
          // REQUIRED: the knowledge.items.created outbox row that drives
          // extraction + embedding is only enqueued for 'pending'. Anything
          // else creates a row the corpus search can never retrieve.
          extractionStatus: 'pending',
          metadata: { importedFrom: candidate.name, importedByAgentId: agentId },
        });
        existingTitles.add(normalizeTitle(title));
        summary.knowledgeItemsCreated += 1;
      } catch (err) {
        log.error(
          { tenantId, title, error: (err as Error).message },
          'absorption-apply: knowledge item creation failed',
        );
      }
    }
  }

  log.info({ tenantId, agentId, ...summary }, 'absorption-apply: complete');
  return summary;
}
