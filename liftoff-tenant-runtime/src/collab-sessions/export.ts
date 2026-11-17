// Consolidate collab-session NDJSON objects into a single validated match export
// the governance rollup reads. Runs in the diagnostics job (bucket-wide read via
// objectAdmin) — the only component permitted to LIST.
//
// Fail-closed: any listing or download failure aborts without touching `latest`.
// A row that fails SCHEMA validation is skipped and counted, and the run aborts
// once the skipped fraction crosses MAX_SKIP_FRACTION — so an isolated bad row
// does not take down an otherwise good export, and a producer emitting a shape
// this cannot read still stops the pipeline rather than quietly shrinking it.
//
// Also hosts the tenant-erasure object sweep (D26 step 1).

import * as crypto from 'crypto';
import { z } from 'zod';
import { Storage } from '@google-cloud/storage';
import { logger } from '../infrastructure/logging';

const SESSIONS_PREFIX = 'diagnostics/collab_sessions/';
const GRADES_PREFIX = 'diagnostics/grades/';
const MATCHES_PREFIX = 'diagnostics/collab_matches/';
/** The MATCH export's row shape — `MatchRecord`, not the collab-session row
 *  (that one is COLLAB_SESSION_SCHEMA_VERSION, currently 3, and the two version
 *  different things). Bump it whenever a field is added, removed or retyped on
 *  MatchRecord.
 *
 *  v2 adds `terminalState`.
 *
 *  NOTHING VALIDATES THIS TODAY. governance-engine's rollup declares
 *  `schema_version` on its ExportMeta and never compares it — it checks sha256
 *  and row_count only — so this number is a truthful label rather than a gate.
 *  Keeping it accurate anyway is what makes building the gate possible later:
 *  a version that silently went stale would make the first real check compare
 *  two shapes that both claim to be v1. */
const MATCH_SCHEMA_VERSION = 2;
const MAX_SKIP_FRACTION = 0.01;

/** invocations.outcome, in full. The CHECK has admitted 'gated' since migration
 *  329 and `InvocationOutcome` has carried it since; this schema enumerated only
 *  three, so every governance-stopped and every human-paused run either aborted
 *  the export (runCollabExport's strict `parse`) or was dropped from grading
 *  without a word (listUngradedSessions' `safeParse` + `continue`). Widened here
 *  in the same change set as governance-engine's MatchRecord.outcome — widening
 *  one alone just moves the failure downstream, where the rollup JSON.parses and
 *  casts without validating. */
const OUTCOME_VALUES = ['success', 'error', 'escalated', 'gated'] as const;

/** agent-execution/types.ts TerminalState, mirrored. Not imported: this module
 *  runs inside the control-plane diagnostics job and reads rows produced by a
 *  DIFFERENT deployment, so the value is validated as data rather than trusted
 *  as a shared type. */
const TERMINAL_STATE_VALUES = [
  'success', 'task_failed', 'escalated', 'gated', 'stopped', 'limit_reached', 'engine_error', 'paused',
] as const;

const SessionRowZ = z.object({
  session_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  human_id: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  outcome: z.enum(OUTCOME_VALUES),
  // schema_version 3+. Absent on every v2 row already in the bucket, and null on
  // backfilled rows, so it is optional AND nullable — a stricter shape here would
  // reject the history this export exists to consolidate.
  terminal_state: z.enum(TERMINAL_STATE_VALUES).nullish(),
  started_at: z.string(),
  emitted_at: z.string(),
  source: z.enum(['live', 'backfill']),
  schema_version: z.number(),
});
type SessionRow = z.infer<typeof SessionRowZ>;

export interface UngradedSession {
  sessionId: string;
  tenantId: string;
  agentId: string;
  emittedAt: string;
}

/** List user-created collab sessions that have no grade object yet, newest
 *  first, capped at `limit`. Backs the bounded incremental grade pass: the full
 *  harvest stays judges-only so it fits the request timeout, and grading — which
 *  roughly doubles per-run LLM cost — runs in small batches here, draining the
 *  backlog across repeated invocations. Every collab session is a tenant-runtime
 *  (user-created) run, so no agent-kind filter is needed. */
export async function listUngradedSessions(bucket: string, limit: number): Promise<UngradedSession[]> {
  const storage = new Storage();
  const [gradeFiles] = await storage.bucket(bucket).getFiles({ prefix: GRADES_PREFIX });
  const graded = new Set(gradeFiles.map((f) => f.name.slice(GRADES_PREFIX.length).replace(/\.ndjson$/, '')));

  const [sessionFiles] = await storage.bucket(bucket).getFiles({ prefix: SESSIONS_PREFIX });
  const bySession = new Map<string, UngradedSession>();
  for (const f of sessionFiles) {
    let rows: unknown[];
    try {
      rows = await readNdjson(storage, bucket, f.name);
    } catch (err) {
      logger.warn({ object: f.name, err: (err as Error).message }, 'collab-grade: unreadable session object, skipping');
      continue;
    }
    for (const raw of rows) {
      const parsed = SessionRowZ.safeParse(raw);
      if (!parsed.success) {
        // Logged rather than dropped in silence. This `continue` is why a gated
        // session was excluded from GRADING without ever aborting anything,
        // while the same row aborted the export outright — one file, two
        // strictnesses, and the quiet half is the one nobody noticed.
        logger.warn(
          { object: f.name, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) },
          'collab-grade: row failed schema validation, not eligible for grading',
        );
        continue;
      }
      const row = parsed.data;
      if (graded.has(row.session_id)) continue;
      const existing = bySession.get(row.session_id);
      // Dedupe per session with the same precedence as the export (live > backfill,
      // later emitted_at wins) so we grade each run once.
      if (!existing || row.emitted_at > existing.emittedAt) {
        bySession.set(row.session_id, { sessionId: row.session_id, tenantId: row.tenant_id, agentId: row.agent_id, emittedAt: row.emitted_at });
      }
    }
  }
  return [...bySession.values()]
    .sort((a, b) => (a.emittedAt < b.emittedAt ? 1 : a.emittedAt > b.emittedAt ? -1 : 0))
    .slice(0, Math.max(0, limit));
}

export interface MatchRecord {
  tenantId: string;
  sessionId: string;
  agentId: string;
  humanId: string | null;
  backbone: string;
  scope: string;
  y: number | null;
  outcome: (typeof OUTCOME_VALUES)[number];
  /** Carried through to the rollup so the fold can separate the two states that
   *  collapse onto outcome='gated': a governance REFUSAL and a run PAUSED for a
   *  person. Null for rows emitted before schema_version 3 and for backfilled
   *  rows. MUST stay in step with governance-engine's MatchRecord. */
  terminalState: (typeof TERMINAL_STATE_VALUES)[number] | null;
  startedAt: string;
}

export interface ExportMeta {
  schema_version: number;
  row_count: number;
  sha256: string;
  watermark: string;      // max(emitted_at) across exported sessions
  created_at: string;
  data_object: string;
}

async function readNdjson(storage: Storage, bucket: string, name: string): Promise<unknown[]> {
  const [buf] = await storage.bucket(bucket).file(name).download();
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Consolidate + validate all session objects into one match export. Returns the
 *  published meta. Throws (fail-closed) on any error before `latest` is touched. */
export async function runCollabExport(bucket: string, exportRunId: string, createdAt: string): Promise<ExportMeta> {
  const storage = new Storage();
  const [files] = await storage.bucket(bucket).getFiles({ prefix: SESSIONS_PREFIX });

  // Parse + validate every row; dedupe per session (live > backfill, emitted_at DESC).
  //
  // safeParse, not parse, and the failures are COUNTED.
  //
  // The strict `parse` here threw before `skipped` could ever be incremented, so
  // MAX_SKIP_FRACTION governed a population that structurally could not contain a
  // schema failure — the one class of bad row anybody would want a tolerance for.
  // What it actually tolerated was the much narrower "parsed fine but is missing
  // an id" case below. The two are now one number, and the fail-closed property
  // is preserved by the SAME threshold: a handful of malformed rows are skipped,
  // and a systematic break (a producer emitting a shape this cannot read) trips
  // the fraction and aborts before `latest` is touched.
  const bySession = new Map<string, SessionRow>();
  let watermark = '';
  let seenRows = 0;
  let skipped = 0;
  for (const f of files) {
    if (!f.name.endsWith('.ndjson')) continue;
    const rows = await readNdjson(storage, bucket, f.name);
    for (const raw of rows) {
      seenRows++;
      const parsed = SessionRowZ.safeParse(raw);
      if (!parsed.success) {
        skipped++;
        logger.warn(
          { object: f.name, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) },
          'collab-export: row failed schema validation, counting it as skipped',
        );
        continue;
      }
      const row = parsed.data;
      const prev = bySession.get(row.session_id);
      if (!prev || preferRow(row, prev)) bySession.set(row.session_id, row);
      if (row.emitted_at > watermark) watermark = row.emitted_at;
    }
  }

  // Map to MatchRecords, joining the latest grade score as y.
  const sessions = [...bySession.values()];
  const matches: MatchRecord[] = [];
  for (const s of sessions) {
    if (!s.tenant_id || !s.agent_id || !s.session_id) { skipped++; continue; }
    const y = await gradeScoreFor(storage, bucket, s.session_id);
    matches.push({
      tenantId: s.tenant_id,
      sessionId: s.session_id,
      agentId: s.agent_id,
      humanId: s.human_id,
      backbone: `${s.provider}:${s.model ?? 'unknown'}`,
      scope: 'global',
      y,
      outcome: s.outcome,
      terminalState: s.terminal_state ?? null,
      startedAt: s.started_at,
    });
  }
  // Denominator is every row READ, not every session that survived dedupe: a
  // schema failure never reaches the dedupe map, so measuring against the map
  // would divide the failures by a count they were excluded from.
  if (seenRows > 0 && skipped / seenRows > MAX_SKIP_FRACTION) {
    throw new Error(`collab-export: skip fraction ${(skipped / seenRows).toFixed(3)} of ${seenRows} rows exceeds ${MAX_SKIP_FRACTION}`);
  }

  matches.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.sessionId < b.sessionId ? -1 : 1));

  const payload = matches.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const dataObject = `${MATCHES_PREFIX}data-${exportRunId}.ndjson`;

  // Write the immutable data object FIRST, then publish meta (overwrite).
  await storage.bucket(bucket).file(dataObject).save(payload, { contentType: 'application/x-ndjson', resumable: false });
  const meta: ExportMeta = {
    schema_version: MATCH_SCHEMA_VERSION,
    row_count: matches.length,
    sha256,
    watermark: watermark || createdAt,
    created_at: createdAt,
    data_object: dataObject,
  };
  await storage.bucket(bucket).file(`${MATCHES_PREFIX}latest.meta.json`).save(JSON.stringify(meta), { contentType: 'application/json', resumable: false });

  // Delete stale data-* objects the new meta does not reference.
  const [dataFiles] = await storage.bucket(bucket).getFiles({ prefix: `${MATCHES_PREFIX}data-` });
  for (const df of dataFiles) {
    if (df.name !== dataObject) await df.delete().catch(() => undefined);
  }
  logger.info({ exportRunId, rowCount: matches.length, seenRows, skipped }, 'collab-export published');
  return meta;
}

function preferRow(candidate: SessionRow, existing: SessionRow): boolean {
  // live outranks backfill; within a source, the later emitted_at wins.
  const rank = (s: SessionRow) => (s.source === 'live' ? 1 : 0);
  if (rank(candidate) !== rank(existing)) return rank(candidate) > rank(existing);
  return candidate.emitted_at > existing.emitted_at;
}

async function gradeScoreFor(storage: Storage, bucket: string, sessionId: string): Promise<number | null> {
  try {
    const rows = await readNdjson(storage, bucket, `${GRADES_PREFIX}${sessionId}.ndjson`);
    const latest = rows
      .map((r) => r as { score?: number; created_at?: string })
      .sort((a, b) => (a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1)[0];
    return typeof latest?.score === 'number' ? latest.score : null;
  } catch {
    return null;
  }
}

/** Delete every object holding a tenant's collab data: sessions/rubrics/grades
 *  rows whose parsed tenant_id matches, plus the tenant artifact prefix. */
export async function eraseTenantObjects(bucket: string, tenantId: string): Promise<{ deleted: number }> {
  const storage = new Storage();
  let deleted = 0;

  for (const prefix of [SESSIONS_PREFIX, GRADES_PREFIX, 'diagnostics/rubrics/']) {
    const [files] = await storage.bucket(bucket).getFiles({ prefix });
    for (const f of files) {
      if (!f.name.endsWith('.ndjson')) continue;
      let matches = false;
      try {
        const rows = await readNdjson(storage, bucket, f.name);
        matches = rows.some((r) => (r as { tenant_id?: string }).tenant_id === tenantId);
      } catch {
        matches = false;
      }
      if (matches) { await f.delete().catch(() => undefined); deleted++; }
    }
  }

  const [artifacts] = await storage.bucket(bucket).getFiles({ prefix: `${tenantId}/artifacts/` });
  for (const a of artifacts) { await a.delete().catch(() => undefined); deleted++; }

  logger.info({ tenantId, deleted }, 'collab tenant erasure (objects) complete');
  return { deleted };
}
