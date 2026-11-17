#!/usr/bin/env node
/**
 * collab-skill-rollup — recompute the CollabSkill posterior store from the
 * consolidated match export.
 *
 * SHADOW SUBSTRATE. Stateless full recompute: every run reads the whole match
 * set from a single validated export object, folds it from empty priors via the
 * selected updater, then upserts all posteriors and deletes rows from prior runs
 * of the same model_version — inside one advisory-locked transaction, so
 * concurrent runs of the same model serialize and the end state is idempotent.
 *
 * Fail-closed on INTEGRITY: a missing export, a sha256 that does not match the
 * meta, or a row count that does not match the meta aborts before any posterior
 * is touched.
 *
 * NOT fail-closed on COMPATIBILITY. This header used to name schema_version
 * alongside the other two. It is declared on ExportMeta below and compared with
 * nothing, so a producer that changes the match row's shape is consumed silently
 * by whatever fold happens to be deployed here. The exporter versions the shape
 * honestly (MATCH_SCHEMA_VERSION in tenant-runtime's collab-sessions/export.ts,
 * now 2), so the number to check against is there when someone builds the check
 * — which is the ordering constraint between these two independently deployed
 * services, currently held by hand at release time. Deliberately left as
 * hardening rather than smuggled into a defect fix.
 *
 * DB identity: connects as the table owner (governance_app). GE RLS is ENABLE
 * (not FORCE), so the owner reads/writes every tenant's rows. INVARIANT: these
 * tables must not be switched to FORCE while this job exists; if FORCE is ever
 * required, provision governance_admin's password first and switch DB_USER.
 *
 * Env: DB_HOST | CLOUD_SQL_CONNECTION_NAME, DB_PORT, DB_NAME (governance_engine),
 *      DB_USER (default governance_app), DB_PASSWORD | DB_PASSWORD_SECRET,
 *      COLLAB_GCS_BUCKET, COLLAB_ROLLUP_EPOCH (default 2026-05-01),
 *      COLLAB_MODEL_VERSION (default mechanical-v0).
 * Flags: --model-version <v>, --erase-tenant <tenantId>, --run-id <id>.
 */

import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { createHash } from 'crypto';
import { UPDATERS } from '../../collab-skill/updaters/registry';
import { posteriorKey, type MatchRecord, type SkillPosterior } from '../../collab-skill/types';

const MATCHES_PREFIX = 'diagnostics/collab_matches/';
const RETENTION_DAYS = 350; // stay inside the trajectory bucket's 365d lifecycle

interface ExportMeta {
  schema_version: number;
  row_count: number;
  sha256: string;
  watermark: string;
  created_at: string;
  data_object: string;
}

function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function resolveSecret(secretRef: string): Promise<string> {
  if (!secretRef.startsWith('projects/')) return secretRef;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: secretRef });
  const payload = version.payload?.data?.toString('utf8');
  if (!payload) throw new Error(`Secret ${secretRef} returned empty payload`);
  return payload;
}

function resolveDbHost(): string {
  if (process.env.DB_HOST) return process.env.DB_HOST;
  const connName = process.env.CLOUD_SQL_CONNECTION_NAME || process.env.DB_INSTANCE_CONNECTION_NAME;
  if (connName) return `/cloudsql/${connName}`;
  return '127.0.0.1';
}

async function buildPool(): Promise<Pool> {
  const passwordSecret = process.env.DB_PASSWORD_SECRET;
  const password = passwordSecret ? await resolveSecret(passwordSecret) : process.env.DB_PASSWORD;
  if (!password) throw new Error('collab-skill-rollup: DB_PASSWORD or DB_PASSWORD_SECRET is required');
  return new Pool({
    host: resolveDbHost(),
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'governance_engine',
    // Table owner; RLS ENABLE ⇒ owner bypass (see file header INVARIANT).
    user: process.env.DB_USER || 'governance_app',
    password,
    max: 4,
  });
}

/** Read + verify the export. Throws (fail-closed) on any mismatch. */
async function loadMatches(bucket: string): Promise<{ matches: MatchRecord[]; meta: ExportMeta }> {
  const storage = new Storage();
  const [metaBuf] = await storage.bucket(bucket).file(`${MATCHES_PREFIX}latest.meta.json`).download();
  const meta = JSON.parse(metaBuf.toString('utf8')) as ExportMeta;
  const [dataBuf] = await storage.bucket(bucket).file(meta.data_object).download();
  const payload = dataBuf.toString('utf8');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  if (sha256 !== meta.sha256) throw new Error('collab-skill-rollup: export checksum mismatch — aborting');
  const matches = payload.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as MatchRecord);
  if (matches.length !== meta.row_count) throw new Error(`collab-skill-rollup: row_count mismatch (${matches.length} vs ${meta.row_count})`);
  return { matches, meta };
}

const UPSERT_SQL = `
  INSERT INTO collab_skill (tenant_id, entity_type, entity_id, scope, mu, sigma,
                            n_observations, model_version, computed_in_run, last_match_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
  ON CONFLICT (tenant_id, entity_type, entity_id, scope, model_version) DO UPDATE SET
    mu = EXCLUDED.mu, sigma = EXCLUDED.sigma, n_observations = EXCLUDED.n_observations,
    computed_in_run = EXCLUDED.computed_in_run, last_match_at = EXCLUDED.last_match_at,
    updated_at = NOW()`;

export async function runCollabSkillRollup(
  pool: Pool,
  opts: { bucket: string; modelVersion: string; epochIso: string; runId: string; logger?: (m: string) => void },
): Promise<{ entities: number; matches: number }> {
  const log = opts.logger ?? ((m: string) => console.log(m));
  const updater = UPDATERS[opts.modelVersion];
  if (!updater) throw new Error(`collab-skill-rollup: unknown model_version "${opts.modelVersion}"`);

  const { matches } = await loadMatches(opts.bucket);

  // Retention-bounded window: never claim to remember matches the bucket has
  // already deleted (365d lifecycle). Log when the clamp binds.
  // Compare instants, not ISO strings (epoch and retention floor may differ in
  // millisecond precision, which breaks lexical comparison).
  const retentionFloorMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const requestedEpochMs = Date.parse(opts.epochIso);
  const effectiveEpochMs = Math.max(requestedEpochMs, retentionFloorMs);
  if (effectiveEpochMs !== requestedEpochMs) {
    log(`[collab-skill-rollup] epoch clamped to retention floor ${new Date(retentionFloorMs).toISOString()} (requested ${opts.epochIso})`);
  }
  const windowed = matches
    .filter((m) => Date.parse(m.startedAt) >= effectiveEpochMs)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.sessionId < b.sessionId ? -1 : 1));

  const posteriors = updater.update(windowed);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent rollups of the SAME model_version.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opts.modelVersion]);
    for (const p of posteriors.values()) {
      await client.query(UPSERT_SQL, [
        p.tenantId, p.entityType, p.entityId, p.scope, p.mu, p.sigma,
        p.nObservations, opts.modelVersion, opts.runId, p.lastMatchAt,
      ]);
    }
    await client.query(
      `DELETE FROM collab_skill WHERE model_version = $1 AND computed_in_run <> $2`,
      [opts.modelVersion, opts.runId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const byType = countByType(posteriors);
  log(`[collab-skill-rollup] model=${opts.modelVersion} matches=${windowed.length} entities=${posteriors.size} byType=${JSON.stringify(byType)}`);
  return { entities: posteriors.size, matches: windowed.length };
}

function countByType(posteriors: Map<string, SkillPosterior>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of posteriors.values()) out[p.entityType] = (out[p.entityType] ?? 0) + 1;
  return out;
}

/** Erase a tenant's posteriors (runbook erasure step 2). */
export async function eraseTenantPosteriors(pool: Pool, tenantId: string): Promise<number> {
  const res = await pool.query(`DELETE FROM collab_skill WHERE tenant_id = $1`, [tenantId]);
  return res.rowCount ?? 0;
}

// Keep posteriorKey referenced for updaters that key on it (avoids unused import
// churn as the registry grows).
void posteriorKey;

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const pool = await buildPool();
  try {
    if (typeof cli['erase-tenant'] === 'string') {
      const deleted = await eraseTenantPosteriors(pool, cli['erase-tenant']);
      console.log(`collab-skill-rollup: erased ${deleted} posteriors for tenant ${cli['erase-tenant']}`);
      return;
    }
    const bucket = process.env.COLLAB_GCS_BUCKET;
    if (!bucket) throw new Error('COLLAB_GCS_BUCKET is required');
    const modelVersion = (typeof cli['model-version'] === 'string' && cli['model-version']) || process.env.COLLAB_MODEL_VERSION || 'mechanical-v0';
    const epochIso = process.env.COLLAB_ROLLUP_EPOCH || '2026-05-01T00:00:00Z';
    const runId = (typeof cli['run-id'] === 'string' && cli['run-id']) || `run-${modelVersion}-${epochIso}`;
    await runCollabSkillRollup(pool, { bucket, modelVersion, epochIso, runId });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('collab-skill-rollup failed:', err);
    process.exitCode = 1;
  });
}
