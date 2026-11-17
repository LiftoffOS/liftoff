/**
 * Distill artifact handles.
 *
 * Distillation produces the agent itself — systemPrompt, userInstructions,
 * instructionsMd, skills. Historically the browser carried that back to us on
 * create/update, which meant the artifact crossed the wire twice, arrived
 * client-supplied (so nothing tied an agent to the template it claimed), and
 * lost the fields the frontend payload never declared.
 *
 * Instead: distill persists the output here and hands back an opaque id;
 * create/update resolve the id server-side. Same ordering invariant that
 * `provisioning-helper.ts` already states for the Liftoff Switch path — persist
 * the distill output BEFORE creating the agent.
 *
 * Distinct from `distillation_cache` on purpose. That table is keyed by a
 * content fingerprint and shared across every caller whose normalized input
 * hashes identically, so it can never address or attribute one request. Both
 * run: the cache decides whether an LLM call happens, and whichever result is
 * served gets an artifact row of its own.
 */
import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { DistillOutput } from './distill-service';

/** How long a handle stays redeemable. Generous relative to the distillation
 *  itself because the window that matters is human: someone distills, walks
 *  away mid-review, and finishes the build later. `distillation_cache` can live
 *  with an hour because a miss there costs an LLM call; a miss here costs the
 *  person their build. */
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a distillation result and return its handle.
 *
 * Throws on failure rather than degrading. A cache write can be swallowed
 * because the caller already holds the result; this one cannot, because the
 * handle is the only way the caller will be able to create the agent.
 */
export async function createDistillArtifact(
  tenantId: string,
  output: DistillOutput,
): Promise<string> {
  const expiresAt = new Date(Date.now() + ARTIFACT_TTL_MS);
  const id = await withTenantScope(tenantId, async (client: PoolClient) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO distill_artifacts (tenant_id, output, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenantId, JSON.stringify(output), expiresAt],
    );
    return result.rows[0]?.id;
  });
  if (!id) {
    throw new Error('distill_artifacts: insert returned no id');
  }
  return id;
}

/**
 * Resolve a handle back to its distillation result.
 *
 * Tenant-scoped in the query, not by the caller afterwards: the tenant
 * predicate is what makes a guessed or replayed id from another workspace
 * indistinguishable from one that never existed. Returns null for unknown,
 * expired, and cross-tenant alike, so callers cannot tell them apart either.
 */
export async function getDistillArtifact(
  artifactId: string,
  tenantId: string,
): Promise<DistillOutput | null> {
  try {
    return await withTenantScope(tenantId, async (client: PoolClient) => {
      const result = await client.query<{ output: DistillOutput; expires_at: Date }>(
        `SELECT output, expires_at FROM distill_artifacts WHERE id = $1 AND tenant_id = $2`,
        [artifactId, tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;

      if (row.expires_at < new Date()) {
        // Expired. Deleted inside the same scope rather than fired off after
        // it: the scope owns the connection, so a detached promise would race
        // its release. RLS also means the delete can only ever reach this
        // tenant's row.
        await client.query(`DELETE FROM distill_artifacts WHERE id = $1`, [artifactId]);
        return null;
      }

      return row.output;
    });
  } catch (err) {
    // An invalid UUID reaches Postgres as a cast error rather than a miss. The
    // zod .uuid() on both routes should prevent it, but a read failure here
    // must not read as "this handle is valid" — treat every failure as absent.
    log.warn({ err, artifactId }, 'distill_artifacts: read failed, treating as missing');
    return null;
  }
}
