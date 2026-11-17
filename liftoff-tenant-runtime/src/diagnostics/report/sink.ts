// Results sink — persist scorecards / clusters / per-run results, and emit the
// log-based metrics that drive gating + alerting.
//
// Primary durable sink: BigQuery (Always-Free tier) per the plan. The BigQuery
// client is an OPTIONAL dependency loaded dynamically so the rest of the
// diagnostics module typechecks/builds even before `@google-cloud/bigquery` is
// added to package.json. When BigQuery is unavailable, results fall back to
// NDJSON in the trajectory GCS bucket (load into BigQuery out of band).
//
// Log-metric emitters: `canary_run_outcome{agent}` (the deploy gate) and
// `agent_health{agent,dimension}` (the passive-eval alerts) mirror the shipped
// canary metric. They are plain structured log lines a Cloud Logging
// log-based metric matches on `jsonPayload.metric`.

import { Storage } from '@google-cloud/storage';
import { logger as log } from '../../infrastructure/logging';
import type { AgentKind } from '../reconstruct/trace-model';
import type { AgentScorecard } from './scorecard';
import type { FailureCluster } from './cluster';

const DATASET = process.env.DIAGNOSTICS_BQ_DATASET ?? 'agent_diagnostics';
const RESULTS_BUCKET = process.env.DIAGNOSTICS_RESULTS_BUCKET ?? process.env.TRAJECTORY_BUCKET;

interface BigQueryTableLike {
  insert(rows: Array<Record<string, unknown>>, opts?: { ignoreUnknownValues?: boolean; skipInvalidRows?: boolean }): Promise<unknown>;
}
interface BigQueryLike {
  dataset(id: string): { table(id: string): BigQueryTableLike };
}

/** Dynamically load the optional BigQuery client. The `as string` on the
 *  specifier defers module resolution so TS does not require the dependency to
 *  be installed for the rest of the module to typecheck. */
async function loadBigQuery(): Promise<BigQueryLike | null> {
  try {
    const mod = (await import('@google-cloud/bigquery' as string)) as { BigQuery: new () => BigQueryLike };
    return new mod.BigQuery();
  } catch {
    return null;
  }
}

async function insertRows(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const bq = await loadBigQuery();
  if (bq) {
    try {
      // `_batch` is a sink-internal key for the NDJSON fallback object name —
      // not a table column. Strip it; ignoreUnknownValues guards any drift.
      const cleaned = rows.map(({ _batch, ...rest }) => {
        void _batch;
        return rest;
      });
      await bq.dataset(DATASET).table(table).insert(cleaned, { ignoreUnknownValues: true, skipInvalidRows: false });
      return;
    } catch (err) {
      log.warn({ message: 'diagnostics sink: BigQuery insert failed, falling back to GCS NDJSON', table, err: (err as Error).message });
    }
  }
  await writeNdjsonFallback(table, rows);
}

async function writeNdjsonFallback(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (!RESULTS_BUCKET) {
    log.warn({ message: 'diagnostics sink: no results bucket configured; dropping rows', table, count: rows.length });
    return;
  }
  // Group rows by their `_batch` id and write one object per group. Callers that
  // want per-entity objects (grades/rubrics keyed by session id) rely on this;
  // callers passing a uniform batch get a single object as before.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const batch = (r._batch as string | undefined) ?? `${table}-${rows.length}`;
    (groups.get(batch) ?? groups.set(batch, []).get(batch)!).push(r);
  }
  const storage = new Storage();
  for (const [batch, groupRows] of groups) {
    const payload = groupRows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const object = `diagnostics/${table}/${batch}.ndjson`;
    try {
      await storage.bucket(RESULTS_BUCKET).file(object).save(payload, { contentType: 'application/x-ndjson', resumable: false });
    } catch (err) {
      log.warn({ message: 'diagnostics sink: GCS NDJSON write failed', table, batch, err: (err as Error).message });
    }
  }
}

export async function sinkScorecards(scorecards: AgentScorecard[]): Promise<void> {
  await insertRows('scorecards', scorecards.map((s) => ({ ...s, findingsByStage: JSON.stringify(s.findingsByStage), _batch: `${s.agentId}-${s.computedAt}` })));
}

export async function sinkClusters(agentKind: AgentKind, agentId: string, clusters: FailureCluster[], computedAt: string): Promise<void> {
  await insertRows(
    'failure_clusters',
    clusters.map((c) => ({ agentKind, agentId, computedAt, ...c, invariants: JSON.stringify(c.invariants), exampleMessages: JSON.stringify(c.exampleMessages), fixSuggestions: JSON.stringify(c.fixSuggestions), _batch: `${agentId}-${computedAt}` })),
  );
}

export async function sinkRunResults(rows: Array<Record<string, unknown>>): Promise<void> {
  await insertRows('run_results', rows);
}

/** Deliverable-grader outputs. One object per session id (via _batch grouping in
 *  the NDJSON fallback), so the grader calibration can GET a session's grade by
 *  its exact object path. The `categories` / `judges` / `per_judge_bias` fields
 *  map to BigQuery JSON columns, so they are written as NATIVE nested JSON (not
 *  stringified — that would land a JSON-string scalar in the column). */
export async function sinkRubrics(rows: Array<Record<string, unknown>>): Promise<void> {
  await insertRows('rubrics', rows.map((r) => ({ ...r, _batch: String((r as { session_id: string }).session_id) })));
}

export async function sinkGrades(rows: Array<Record<string, unknown>>): Promise<void> {
  await insertRows('grades', rows.map((r) => ({ ...r, _batch: String((r as { session_id: string }).session_id) })));
}

export async function sinkCalibrationReports(rows: Array<Record<string, unknown>>): Promise<void> {
  await insertRows('calibration_reports', rows.map((r) => ({ ...r, _batch: String((r as { calibration_run_id: string }).calibration_run_id) })));
}

/** Per-agent rolling baseline for goalSuccessRate: the mean of the most recent
 *  `n` prior scorecards for `kind`. Reads the scorecards NDJSON from the results
 *  bucket (the same data the BigQuery external table exposes), so regression
 *  detection is relative to each agent's own recent history rather than a static
 *  constant. Returns null when there is no bucket or no history (caller falls
 *  back to the static baseline). The object name embeds the ISO `computedAt`, so
 *  a descending name sort is a descending time sort. */
export async function rollingGoalBaseline(kind: AgentKind, n: number): Promise<number | null> {
  if (!RESULTS_BUCKET) return null;
  try {
    const [files] = await new Storage().bucket(RESULTS_BUCKET).getFiles({ prefix: 'diagnostics/scorecards/' });
    files.sort((a, b) => (a.name < b.name ? 1 : -1)); // most recent first
    const vals: number[] = [];
    for (const f of files) {
      if (vals.length >= n) break;
      const [buf] = await f.download();
      for (const line of buf.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { agentKind?: string; goalSuccessRate?: number | null };
          if (row.agentKind === kind && typeof row.goalSuccessRate === 'number') {
            vals.push(row.goalSuccessRate);
            if (vals.length >= n) break;
          }
        } catch {
          /* skip malformed line */
        }
      }
    }
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  } catch (err) {
    log.warn({ message: 'diagnostics: rolling baseline read failed', kind, err: (err as Error).message });
    return null;
  }
}

/** Per-(kind, agentId) rolling baseline for avgDeliverableScore (0-100 scale).
 *  Filters by BOTH kind and agentId so two user-created agents of the same kind
 *  never contaminate each other's baseline. Returns null with no history. */
export async function rollingDeliverableBaseline(kind: AgentKind, agentId: string, n: number): Promise<number | null> {
  if (!RESULTS_BUCKET) return null;
  try {
    const [files] = await new Storage().bucket(RESULTS_BUCKET).getFiles({ prefix: 'diagnostics/scorecards/' });
    files.sort((a, b) => (a.name < b.name ? 1 : -1)); // most recent first
    const vals: number[] = [];
    for (const f of files) {
      if (vals.length >= n) break;
      const [buf] = await f.download();
      for (const line of buf.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { agentKind?: string; agentId?: string; avgDeliverableScore?: number | null };
          if (row.agentKind === kind && row.agentId === agentId && typeof row.avgDeliverableScore === 'number') {
            vals.push(row.avgDeliverableScore);
            if (vals.length >= n) break;
          }
        } catch {
          /* skip malformed line */
        }
      }
    }
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  } catch (err) {
    log.warn({ message: 'diagnostics: deliverable baseline read failed', kind, agentId, err: (err as Error).message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log-based metric emitters.
// ---------------------------------------------------------------------------

/** Deploy-gate metric. The canary smoke step emits one per agent. Uses the
 *  SHIPPED `canary_run_outcome` log-metric contract: `jsonPayload.event =
 *  "canary_run_outcome"` with an `outcome` label ('pass'|'error') and an
 *  `agent` label (added to the metric for per-agent alerting, gating §2). The
 *  `canary_run_failed` alert fires on outcome='error'. */
export function emitCanaryOutcome(agent: AgentKind, passed: boolean, evidence?: Record<string, unknown>): void {
  log.info({ event: 'canary_run_outcome', agent, outcome: passed ? 'pass' : 'error', ...evidence });
}

/** Passive-eval health metric, one per (agent, dimension). Matches the
 *  `agent_health` log-metric (`jsonPayload.event = "agent_health"`); the
 *  alert policy fires when `regressed = "true"`. */
export function emitAgentHealth(agent: AgentKind, dimension: 'goal' | 'conformance' | 'invariant' | 'efficiency' | 'arg_validity' | 'arg_appropriateness' | 'deliverable_quality', value: number, regressed: boolean): void {
  log.info({ event: 'agent_health', agent, dimension, value, regressed: regressed ? 'true' : 'false' });
}
