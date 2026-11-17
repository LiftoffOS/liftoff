// Manual/scheduled job — re-verifies that the external refs our blueprints
// describe still exist upstream, and marks the vanished ones dead.
//
// TARGETED, NEVER A SWEEP OF ANY CATALOG. Blueprints only exist for refs a
// real query adopted, so the whole table IS the reference set; each row costs
// one public lookup. A dead blueprint is worse than none — the prior-art
// section would recommend a procedure for a tool that no longer exists — and
// `dead = true` is how the readers (evidence.ts) exclude it.
//
// A ref that cannot be CHECKED (network failure, upstream error) is left
// alone: inconclusive is not dead, the same rule the migration gate applies.
//
// Triggered with the shared X-Service-Auth / PLATFORM_CALLBACK_TOKEN
// convention used by the other PB internal jobs. Counts in the result are
// measured FROM THE DATABASE, not tallied in the loop.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
// RLS_RAW_POOL_OK: capability_blueprints is platform-scoped with no RLS policy.
import { pool } from '../infrastructure/database';

export const capabilityBlueprintVerifyRouter = Router();

const BATCH = 100;

/** true = exists, false = vanished, null = inconclusive. */
async function refStillExists(source: string, sourceRef: string): Promise<boolean | null> {
  if (source !== 'apify_store') return true; // our own registry refs verify at build time
  try {
    const name = sourceRef.split('/')[1];
    if (!name) return false;
    const resp = await fetch(
      `https://api.apify.com/v2/store?search=${encodeURIComponent(name)}&limit=25`,
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: { items?: Array<{ name?: string; username?: string }> };
    };
    return (body.data?.items ?? []).some((i) => `${i.username}/${i.name}` === sourceRef);
  } catch {
    return null;
  }
}

capabilityBlueprintVerifyRouter.post(
  '/jobs/capability-blueprint-verify',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;

    try {
      const rows = await pool.query<{ source: string; source_ref: string }>(
        `SELECT source, source_ref FROM capability_blueprints
          WHERE dead = false
          ORDER BY last_verified_at ASC
          LIMIT $1`,
        [BATCH],
      );
      const before = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM capability_blueprints WHERE dead = true`,
      );

      for (const row of rows.rows) {
        const exists = await refStillExists(row.source, row.source_ref);
        if (exists === null) continue;
        await pool.query(
          exists
            ? `UPDATE capability_blueprints SET last_verified_at = now(), updated_at = now()
                WHERE source = $1 AND source_ref = $2`
            : `UPDATE capability_blueprints SET dead = true, updated_at = now()
                WHERE source = $1 AND source_ref = $2`,
          [row.source, row.source_ref],
        );
      }

      const after = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM capability_blueprints WHERE dead = true`,
      );
      const markedDead = Number(after.rows[0].n) - Number(before.rows[0].n);
      log.info(
        { metric: 'capability_blueprint.verify', checked: rows.rows.length, markedDead },
        'capability-blueprint-verify: sweep complete',
      );
      return res.json({ checked: rows.rows.length, markedDead });
    } catch (error) {
      log.error({ error }, 'capability-blueprint-verify failed');
      return res.status(500).json({ error: 'verify failed' });
    }
  },
);
