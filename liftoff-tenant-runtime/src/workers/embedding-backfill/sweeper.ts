// Generalized multi-table embedding backfill sweeper.
//
// Sweeps every embedding-bearing table (memories, agent_skills,
// connector_content) for rows with embedding IS NULL, generates the
// missing embedding via the same code path as the live write
// (generateEmbeddingsBatchDetailed → tenant entitlements → cost
// attribution via usage_ledger), and writes back.
//
// Triggered as a Cloud Run Job at deploy time (after migration 259
// NULLs every embedding) and after the provider-switch endpoint (PR-4).
// Steady-state NULL rows are rare; the worker exits in <1s when nothing
// needs filling.
//
// SELECT … FOR UPDATE SKIP LOCKED makes Cloud Run Jobs --parallelism > 1
// safe out of the box — no advisory lock needed.
//
// Generalizes the per-table embedding-sweeper at src/skills/
// embedding-sweeper.ts. That sweeper stays in place for the periodic
// cron route (/api/internal/skill-embedding-sweeper) and keeps the
// agent_skills steady-state recovery path. This worker handles the
// migration-time bulk case across every embedding-bearing table.

import { pool, withTenantScope } from '../../infrastructure/database';
import {
  generateEmbeddingsBatchDetailed,
  EmbeddingDimMismatchError,
} from '../../memory/embedding';
import { log } from '../../infrastructure/logging';
import type { PoolClient } from 'pg';

export interface BackfillSource {
  /** Human-readable label for logs. */
  name: string;
  /** SQL identifier; whitelisted in DEFAULT_SOURCES, NOT user input. */
  table: string;
  /** Column to embed from. */
  textColumn: string;
  /** Predicate appended to WHERE clause (no user input). */
  whereExtra: string;
  /** Whether the table has an `embedding_model` column. connector_content
   *  does NOT (see migration 114), so we omit it from the UPDATE. */
  hasModelColumn: boolean;
  /** Cost-attribution purpose tag. */
  purpose: string;
  /** Table is FORCE RLS, so a pass must run inside `withTenantScope` and can
   *  only ever cover ONE tenant.
   *
   *  A fleet-wide claim across a FORCE-RLS table does not quietly return
   *  nothing — the fail-loud policy raises 42704 — so the alternative to this
   *  flag is a job that aborts. `connector_content` became FORCE RLS in
   *  migration 372, when it started holding customer content. */
  tenantScoped?: boolean;
}

export const DEFAULT_SOURCES: BackfillSource[] = [
  {
    name: 'memories',
    table: 'memories',
    textColumn: 'content',
    whereExtra: '(expires_at IS NULL OR expires_at > NOW()) AND superseded_by IS NULL',
    hasModelColumn: true,
    purpose: 'embedding_backfill_memories',
  },
  {
    name: 'agent_skills',
    table: 'agent_skills',
    textColumn: 'description',
    whereExtra: "status = 'active'",
    hasModelColumn: true,
    purpose: 'embedding_backfill_skills',
  },
  {
    name: 'connector_content',
    table: 'connector_content',
    textColumn: 'content',
    whereExtra: 'expires_at > NOW()',
    hasModelColumn: false,
    purpose: 'embedding_backfill_connector',
    tenantScoped: true,
  },
];

export interface PassResult {
  source: string;
  attempted: number;
  succeeded: number;
  failed: number;
  done: boolean;
}

export interface SweepOptions {
  batchSize: number;
  /** Optional tenant filter — defaults to "all tenants visible in this
   *  DB". For per-tenant runtime DBs (the usual case) this is a single
   *  tenant; for shared multi-tenant deploys the filter narrows. */
  tenantIdFilter?: string;
}

interface ClaimRow {
  id: string;
  tenant_id: string;
  text: string;
}

export async function sweepOnePass(
  src: BackfillSource,
  opts: SweepOptions,
): Promise<PassResult> {
  // A FORCE-RLS source has no fleet-wide pass to run: off a scope its policy
  // raises. Refuse in the caller's terms rather than letting a 42704 surface as
  // an opaque abort halfway through a batch.
  if (src.tenantScoped && !opts.tenantIdFilter) {
    throw new Error(
      `${src.name} is FORCE RLS: sweepOnePass needs a tenantIdFilter. `
      + 'Enumerate tenants and sweep one at a time.',
    );
  }
  if (src.tenantScoped && opts.tenantIdFilter) {
    return withTenantScope(opts.tenantIdFilter, (scoped) =>
      sweepWithClient(src, opts, scoped as PoolClient, false));
  }

  const client: PoolClient = await pool.connect();
  return sweepWithClient(src, opts, client, true);
}

/** The pass itself.
 *
 *  `ownsClient` is false for the tenant-scoped path: `withTenantScope` owns
 *  that client's lifetime, and releasing it here would return a connection to
 *  the pool while the scope still believes it holds it. */
async function sweepWithClient(
  src: BackfillSource,
  opts: SweepOptions,
  client: PoolClient,
  ownsClient: boolean,
): Promise<PassResult> {
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    await client.query('BEGIN');

    // Claim batch. FOR UPDATE SKIP LOCKED → safe for parallel tasks.
    // tenantIdFilter is parameterized; src.table + textColumn + whereExtra
    // are whitelisted module-level identifiers, not request input.
    const tenantParam: unknown[] = opts.tenantIdFilter ? [opts.tenantIdFilter] : [];
    const tenantClause = opts.tenantIdFilter ? 'AND tenant_id = $2' : '';

    const claim = await client.query<ClaimRow>(
      `SELECT id, tenant_id, ${src.textColumn} AS text
       FROM ${src.table}
       WHERE embedding IS NULL
         AND ${src.whereExtra}
         ${tenantClause}
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [opts.batchSize, ...tenantParam],
    );

    if (claim.rows.length === 0) {
      await client.query('COMMIT');
      return { source: src.name, attempted: 0, succeeded: 0, failed: 0, done: true };
    }

    attempted = claim.rows.length;

    // Group by tenant — entitlement-resolved provider/dim may differ per
    // tenant. For per-tenant runtime DBs the group is always size 1.
    const byTenant = new Map<string, { ids: string[]; texts: string[] }>();
    for (const row of claim.rows) {
      let group = byTenant.get(row.tenant_id);
      if (!group) {
        group = { ids: [], texts: [] };
        byTenant.set(row.tenant_id, group);
      }
      group.ids.push(row.id);
      group.texts.push(row.text);
    }

    for (const [tenantId, group] of byTenant) {
      try {
        const result = await generateEmbeddingsBatchDetailed(group.texts, {
          tenantId,
          purpose: src.purpose,
          taskType: 'retrieval_document',
        });

        // Bulk UPDATE via unnest. Two shapes — with and without
        // embedding_model. The guard on `embedding IS NULL` lets multiple
        // workers race safely.
        if (src.hasModelColumn) {
          await client.query(
            `UPDATE ${src.table} AS t
             SET embedding = src.embedding::vector,
                 embedding_model = $1,
                 updated_at = NOW()
             FROM (
               SELECT UNNEST($2::uuid[]) AS id,
                      UNNEST($3::text[]) AS embedding
             ) AS src
             WHERE t.id = src.id AND t.embedding IS NULL`,
            [
              result.model,
              group.ids,
              result.embeddings.map(e => `[${e.join(',')}]`),
            ],
          );
        } else {
          await client.query(
            `UPDATE ${src.table} AS t
             SET embedding = src.embedding::vector,
                 updated_at = NOW()
             FROM (
               SELECT UNNEST($1::uuid[]) AS id,
                      UNNEST($2::text[]) AS embedding
             ) AS src
             WHERE t.id = src.id AND t.embedding IS NULL`,
            [
              group.ids,
              result.embeddings.map(e => `[${e.join(',')}]`),
            ],
          );
        }

        succeeded += group.ids.length;
      } catch (err) {
        failed += group.ids.length;
        if (err instanceof EmbeddingDimMismatchError) {
          // Dim mismatch is a config error, not a transient. Aborting
          // here is correct — retrying without fixing the config just
          // wastes API calls.
          log.error(
            { err: err.message, source: src.name, tenantId },
            'embedding-backfill: dim mismatch — aborting (config issue)',
          );
          throw err;
        }
        log.error(
          { err: (err as Error).message, source: src.name, tenantId },
          'embedding-backfill: batch embed failed (will retry on next pass)',
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }

  return { source: src.name, attempted, succeeded, failed, done: false };
}
