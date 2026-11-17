// Auto-promote reflection suggestions to memories.
//
// Called after the reflection engine generates a suggestion. If confidence >= 0.7,
// sanitizes content, detects PII, and saves as an individual-layer memory with
// 90-day TTL and 24h quarantine. Logs an audit entry with original vs sanitized diff.
//
// Below 0.7: returns { promoted: false } — medium-confidence suggestions remain
// pending for corroboration or human review.
//
// This function is fire-and-forget from the caller's perspective. The memory
// save stands alone — it generates an embedding over the network, which must not
// hold a transaction open — and carries its own quarantine on the INSERT. The
// suggestion status and the audit row share one transaction, so a promoted
// suggestion always has the audit entry that explains it.

import { memoryService } from '../memory/service';
import { sanitizeMemoryContent } from '../memory/content-sanitizer';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { Clock } from '../test-utils/clock';
import { systemClock } from '../test-utils/clock';

const CONFIDENCE_THRESHOLD = 0.7;
const AUTO_REFLECTION_TTL_DAYS = 90;
const QUARANTINE_HOURS = 24;

const SEVERITY_TO_IMPORTANCE: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
};

export interface AutoPromoteResult {
  promoted: boolean;
  memoryId?: string;
  deduplicated?: boolean;
  piiDetected?: boolean;
}

export async function autoPromoteReflection(
  tenantId: string,
  agentId: string,
  suggestion: {
    id: string;
    suggestion: string;
    confidenceScore: number;
    severity: string;
    connectorType?: string;
    toolName?: string;
    errorCategory?: string;
  },
  clock: Clock = systemClock,
): Promise<AutoPromoteResult> {
  if (suggestion.confidenceScore < CONFIDENCE_THRESHOLD) {
    return { promoted: false };
  }

  // Step 1: PII scan + content sanitization
  const sanitization = sanitizeMemoryContent(suggestion.suggestion);
  const contentClassification = sanitization.piiDetected ? 'pii' : 'internal';

  // Step 2: Build structured tags
  const tags: string[] = ['auto-reflection', 'high-confidence'];
  if (suggestion.connectorType) tags.push(`connector:${suggestion.connectorType}`);
  if (suggestion.toolName) tags.push(`tool:${suggestion.toolName}`);
  if (suggestion.errorCategory) tags.push(`error:${suggestion.errorCategory}`);

  // Step 3: Compute derived fields
  const importanceScore = SEVERITY_TO_IMPORTANCE[suggestion.severity] ?? 3;
  const now = new Date(clock());
  const quarantineUntil = new Date(now.getTime() + QUARANTINE_HOURS * 60 * 60 * 1000);
  const expiresAt = new Date(now.getTime() + AUTO_REFLECTION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const pool = getPoolForService('scheduled-execution');

  try {
    // Step 4: Save memory with semantic dedup. The quarantine and importance are
    // set by this INSERT, not by a follow-up UPDATE: a NULL `retrievable_after`
    // is retrievable at every read site, so a row written without it is exposed
    // until the second statement lands, and permanently if that statement fails.
    // saveMemory generates an embedding over the network before it writes, so it
    // stays outside the transaction below.
    const { memoryId, deduplicated } = await memoryService.saveMemory({
      tenantId,
      agentId,
      layer: 'individual',
      scopeKey: agentId,
      content: sanitization.sanitized,
      contentClassification: contentClassification as any,
      tags,
      expiresAt,
      semanticDedup: true, // Improvement 4: skip if >0.9 similar memory exists
      retrievableAfter: quarantineUntil,
      importanceScore,
      source: {
        nodeType: 'system_event' as const,
        refId: suggestion.id,
        agentId,
        confidence: suggestion.confidenceScore,
        metadata: { triggerType: 'auto_promote' },
      },
    });

    // Step 5 and 6 together: the suggestion is only marked auto-promoted if its
    // audit row lands, so the two cannot disagree about what happened.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE reflection_suggestions SET status = 'auto-promoted', applied_at = $1 WHERE id = $2`,
        [now, suggestion.id],
      );
      await client.query(
        `INSERT INTO instruction_amendment_audit (tenant_id, agent_id, amendment_type, source_memory_ids, before_md, after_md)
         VALUES ($1, $2, 'auto_promotion', ARRAY[$3]::uuid[], $4, $5)`,
        [tenantId, agentId, suggestion.id, suggestion.suggestion, sanitization.sanitized],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // The memory is already committed — it is written before this transaction
      // opens, because generating its embedding is a network call. Rolling back
      // alone would leave a promoted memory attached to a suggestion still
      // marked pending, and the next run would promote the same content again.
      // Withdraw it so the whole promotion is all-or-nothing. Only a row this
      // call actually inserted may be withdrawn: on a dedup hit the id belongs
      // to a memory that already existed and is not ours to remove.
      if (!deduplicated) {
        await memoryService.deleteMemory(memoryId, tenantId).catch((cleanupErr) =>
          logger.error({
            tenantId,
            agentId,
            memoryId,
            suggestionId: suggestion.id,
            error: (cleanupErr as Error).message,
          }, 'auto-promote: promotion rolled back but its memory could not be withdrawn'),
        );
      }
      throw err;
    } finally {
      client.release();
    }

    logger.info({
      tenantId,
      agentId,
      suggestionId: suggestion.id,
      memoryId,
      confidence: suggestion.confidenceScore,
      severity: suggestion.severity,
      piiDetected: sanitization.piiDetected,
      strippedCount: sanitization.strippedPatterns.length,
      deduplicated,
    }, 'auto-promote: reflection promoted to memory');

    return {
      promoted: true,
      memoryId,
      deduplicated,
      piiDetected: sanitization.piiDetected,
    };
  } catch (error) {
    logger.warn({
      tenantId,
      agentId,
      suggestionId: suggestion.id,
      error: (error as Error).message,
    }, 'auto-promote: failed (non-fatal)');

    return { promoted: false };
  }
}
