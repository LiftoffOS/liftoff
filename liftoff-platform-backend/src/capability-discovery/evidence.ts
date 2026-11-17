// Capability discovery — persistence seam (usage evidence + blueprints).
//
// Both tables are PLATFORM-scoped: no tenant_id scoping, no RLS. tenant_id on
// an evidence row is attribution for diagnosis, not a boundary — the whole
// point of evidence is that one tenant's failed run warns every other
// tenant's ranking off the same candidate.
//
// Every read here fails soft to empty: discovery must keep answering when the
// database is unhappy, just with less context. Writes fail soft too — an
// evidence row is never worth failing the execution it describes.

// RLS_RAW_POOL_OK: capability_usage_evidence and capability_blueprints are
// platform-scoped tables with no RLS policy; there is no tenant scope to set.
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { Candidate } from './types';

export interface EvidenceCounts {
  successes: number;
  failures: number;
  /** What a successful call has cost on average, when any recorded one. */
  avgCostUsd?: number;
  /** How long a successful call has taken, at the median, when recorded. */
  medianLatencyMs?: number;
}

const evidenceKey = (source: string, sourceRef: string) => `${source}:${sourceRef}`;

/** Aggregate execution evidence for a candidate batch, one query. */
export async function getEvidenceForCandidates(
  candidates: Candidate[],
): Promise<Map<string, EvidenceCounts>> {
  const out = new Map<string, EvidenceCounts>();
  if (candidates.length === 0) return out;
  try {
    const sources = candidates.map((c) => c.source);
    const refs = candidates.map((c) => c.sourceRef);
    const result = await pool.query<{
      source: string;
      source_ref: string;
      successes: string;
      failures: string;
      avg_cost_usd: string | null;
      median_latency_ms: string | null;
    }>(
      `SELECT source, source_ref,
              COUNT(*) FILTER (WHERE success) AS successes,
              COUNT(*) FILTER (WHERE NOT success) AS failures,
              AVG(cost_usd) FILTER (WHERE success AND cost_usd IS NOT NULL) AS avg_cost_usd,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE success AND latency_ms IS NOT NULL) AS median_latency_ms
         FROM capability_usage_evidence
        WHERE (source, source_ref) IN (
              SELECT UNNEST($1::text[]), UNNEST($2::text[]))
        GROUP BY source, source_ref`,
      [sources, refs],
    );
    for (const row of result.rows) {
      const avgCostUsd = row.avg_cost_usd === null ? undefined : Number(row.avg_cost_usd);
      const medianLatencyMs = row.median_latency_ms === null ? undefined : Number(row.median_latency_ms);
      out.set(evidenceKey(row.source, row.source_ref), {
        successes: Number(row.successes),
        failures: Number(row.failures),
        ...(avgCostUsd !== undefined && Number.isFinite(avgCostUsd) ? { avgCostUsd } : {}),
        ...(medianLatencyMs !== undefined && Number.isFinite(medianLatencyMs) ? { medianLatencyMs } : {}),
      });
    }
  } catch (error) {
    log.warn({ error }, 'capability-discovery: evidence read failed; ranking without it');
  }
  return out;
}

export interface EvidenceWrite {
  source: string;
  sourceRef: string;
  tenantId: string | null;
  success: boolean;
  latencyMs?: number;
  costUsd?: number;
  /** One-line shape note, never a payload. */
  outputNote?: string;
}

export async function recordUsageEvidence(w: EvidenceWrite): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO capability_usage_evidence
         (source, source_ref, tenant_id, success, latency_ms, cost_usd, output_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        w.source,
        w.sourceRef,
        w.tenantId,
        w.success,
        w.latencyMs ?? null,
        w.costUsd ?? null,
        (w.outputNote ?? '').slice(0, 300) || null,
      ],
    );
  } catch (error) {
    log.warn({ error, sourceRef: w.sourceRef }, 'capability-discovery: evidence write failed');
  }
}

/** Record that an agent's distillation consumed these refs in its PRIOR ART
 *  section. Upsert on the natural key: the record answers "who was authored
 *  against this knowledge", not "how many times". Fails soft — the distill
 *  must never wait on or fail over its own bookkeeping. */
export async function recordDistillConsumption(
  tenantId: string,
  agentId: string,
  refs: Array<{ source: string; sourceRef: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO capability_distill_consumption (tenant_id, agent_id, source, source_ref)
       SELECT $1, $2, UNNEST($3::text[]), UNNEST($4::text[])
       ON CONFLICT (tenant_id, agent_id, source, source_ref) DO NOTHING`,
      [tenantId, agentId, refs.map((r) => r.source), refs.map((r) => r.sourceRef)],
    );
  } catch (error) {
    log.warn({ error, agentId }, 'capability-discovery: consumption write failed');
  }
}

/** The agents whose distillations consumed one ref — the upgrade loop's
 *  fan-out set. Bounded: an elevation refreshing more agents than this in one
 *  pass should page on later elevations rather than stampede redistills. */
export async function getConsumersOfRef(
  source: string,
  sourceRef: string,
  limit: number,
): Promise<Array<{ tenantId: string; agentId: string }>> {
  try {
    const result = await pool.query<{ tenant_id: string; agent_id: string }>(
      `SELECT DISTINCT tenant_id, agent_id
         FROM capability_distill_consumption
        WHERE source = $1 AND source_ref = $2
        LIMIT $3`,
      [source, sourceRef, limit],
    );
    return result.rows.map((r) => ({ tenantId: r.tenant_id, agentId: r.agent_id }));
  } catch (error) {
    log.warn({ error, sourceRef }, 'capability-discovery: consumer read failed');
    return [];
  }
}

/** Blueprint procedures for a candidate batch — our own authored deep tier.
 *  Dead blueprints (source_ref vanished upstream) are excluded: recommending
 *  a procedure for a tool that no longer exists is worse than none. */
export async function getBlueprintsForCandidates(
  candidates: Candidate[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (candidates.length === 0) return out;
  try {
    const sources = candidates.map((c) => c.source);
    const refs = candidates.map((c) => c.sourceRef);
    const result = await pool.query<{ source: string; source_ref: string; procedure_md: string }>(
      `SELECT source, source_ref, procedure_md
         FROM capability_blueprints
        WHERE dead = false
          AND replicable = true
          AND (source, source_ref) IN (
              SELECT UNNEST($1::text[]), UNNEST($2::text[]))`,
      [sources, refs],
    );
    for (const row of result.rows) {
      out.set(evidenceKey(row.source, row.source_ref), row.procedure_md);
    }
  } catch (error) {
    log.warn({ error }, 'capability-discovery: blueprint read failed; ranking without them');
  }
  return out;
}
