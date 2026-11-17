// WS-8.2 — Layer 2 deep-scan worker.
//
// Claims a batch of pending memories, runs each through the LLM provider
// abstraction (tier: 'small', purpose: 'dlp_deep_scan'), quarantines on hit.

import { llmClient } from '../llm/client';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { scrubLogger } from '../observability/scrub-logger';
import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';

/** A claim older than this belongs to a worker that died mid-batch. */
const STALE_CLAIM = "INTERVAL '15 minutes'";

/** Arm a scan for memories that were just queued. Called from the only insert
 *  into memories_pending_deep_scan; the scan re-arms itself while it is making
 *  progress, and the daily housekeeping pass is the backstop. */
export function armDeepScan(): void {
  armWatch('memory-deep-scan', MAINTENANCE_PATHS.memoryDeepScan, { delayMs: 60_000 });
}

const SCAN_PROMPT = `You are a security scanner. Read the following content
and determine whether it contains any sensitive credentials, secrets, or
authentication tokens that should never be persisted (API keys, OAuth
tokens, passwords, private keys, session cookies, JWTs, etc).

Respond with a single JSON object:
{
  "contains_secret": boolean,
  "kinds": [/* e.g. "stripe_secret_key", "session_cookie" */],
  "reason": "<one-sentence justification>"
}

Content to scan:
"""
{CONTENT}
"""`;

export async function runDeepScanTick(): Promise<{ scanned: number; quarantined: number }> {
  const pool = getPool();
  const claimToken = `worker-${process.env.HOSTNAME ?? 'unknown'}-${Date.now()}`;
  const claimed = await pool.query(
    `UPDATE memories_pending_deep_scan
     SET claimed_at = NOW(), claimed_by = $1
     WHERE id IN (
       SELECT id FROM memories_pending_deep_scan
       WHERE claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}
       ORDER BY enqueued_at
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, memory_id, tenant_id`,
    [claimToken],
  );

  let scanned = 0;
  let quarantined = 0;
  for (const row of claimed.rows) {
    const memory = await pool.query(`SELECT content FROM memories WHERE id = $1`, [row.memory_id]);
    if (memory.rowCount === 0) {
      await pool.query(`DELETE FROM memories_pending_deep_scan WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      const response = await llmClient.complete(
        {
          tier: 'small',
          messages: [
            { role: 'user', content: SCAN_PROMPT.replace('{CONTENT}', memory.rows[0].content) },
          ],
        } as never,
        undefined,
        { tenantId: row.tenant_id, purpose: 'dlp_deep_scan' },
      );
      const text = (response as unknown as { text?: string; content?: string }).text
        ?? (response as unknown as { content?: string }).content
        ?? '';
      let parsed: { contains_secret?: boolean; kinds?: string[]; reason?: string };
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      if (parsed.contains_secret) {
        await pool.query(
          `UPDATE memories SET dlp_quarantine_at = NOW(), dlp_quarantine_reason = $1 WHERE id = $2`,
          [parsed.reason ?? 'deep-scan flagged', row.memory_id],
        );
        await pool.query(
          `INSERT INTO dlp_quarantine_audit (memory_id, tenant_id, detector, finding_kinds, llm_response)
           VALUES ($1, $2, 'layer2_deep_scan', $3, $4)`,
          [row.memory_id, row.tenant_id, parsed.kinds ?? [], parsed],
        );
        scrubLogger.warn({
          event: 'dlp_quarantine_recorded',
          detector: 'layer2_deep_scan',
          tenant_id: row.tenant_id,
          memory_id: row.memory_id,
          finding_kinds: parsed.kinds ?? [],
        });
        quarantined++;
      }
    } catch (err) {
      // Release the claim rather than deleting the row: this memory has not
      // been scanned, and the next pass must see it.
      logger.warn(
        { err: (err as Error).message, memory_id: row.memory_id },
        'deep-scan: LLM call failed; will retry on next tick',
      );
      await pool.query(
        `UPDATE memories_pending_deep_scan SET claimed_at = NULL, claimed_by = NULL WHERE id = $1`,
        [row.id],
      );
      continue;
    }
    await pool.query(`DELETE FROM memories_pending_deep_scan WHERE id = $1`, [row.id]);
    scanned++;
  }
  // More queued than one batch takes: come back soon. Only after progress, so
  // a scanner that keeps failing waits for the daily pass instead of looping.
  if (scanned > 0 && claimed.rows.length === 50) armDeepScan();
  return { scanned, quarantined };
}
