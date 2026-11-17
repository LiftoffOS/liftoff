// Where a fetched result lives: a dataset row and one row per record
// (migration 511), scoped to the job that fetched it.
//
// A result is parked here whole, and the model that asked for it is handed
// a view — the count, the fields, a sample, the id — never the records. What
// it needs from them it asks for through the query (query.ts) or the
// extraction (extract.ts), both of which read these rows and return only
// what was asked. A job can add to a dataset as its work goes on: a run
// that fetches the comments under each of twenty posts appends twenty
// times to one dataset rather than handing the model twenty handles.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

/** The most records a dataset keeps. A result beyond it keeps its first
 *  records and says so in the count it reports. */
const MAX_DATASET_RECORDS = 50_000;
/** The most a dataset's records may serialize to, in characters. */
const MAX_DATASET_CHARS = 32_000_000;
/** Records read when profiling a dataset's fields. Enough for the shape;
 *  a profile of every record would be a second copy of the data. */
const PROFILE_SAMPLE = 500;
/** Records written per statement. */
const INSERT_BATCH = 500;
/** How much of a sample value the field profile keeps. */
const SAMPLE_CHARS = 60;

export type DatasetScopeKind = 'liftoff_thread' | 'insights_thread' | 'caio_thread' | 'agent_run' | 'unscoped';

export interface DatasetScope {
  kind: DatasetScopeKind;
  id: string;
}

export type FieldType = 'text' | 'number' | 'boolean' | 'list' | 'object' | 'mixed';

/** One top-level field's shape across the records: what it holds, how often
 *  it holds anything, how big, and one short sample. */
export interface FieldStat {
  name: string;
  type: FieldType;
  /** Share of records where the field carries a value, 0–1. */
  present: number;
  /** Text: average length of the values present. */
  avgChars?: number;
  /** List: average item count of the values present. */
  avgItems?: number;
  sample?: string;
}

export interface DatasetSummary {
  id: string;
  label: string;
  source: string;
  sourceRef: string;
  recordCount: number;
  bytes: number;
  fields: FieldStat[];
  createdAt: Date;
  /** How many runs of the job added records: 1 for a dataset written once,
   *  more when later runs appended (each record then carries `_run`). */
  runs: number;
}

export interface NewDataset {
  scope: DatasetScope;
  /** Model-facing name for what the records are: never a vendor. */
  label: string;
  /** The building block that produced them, as capability_usage_evidence
   *  names it. Operator-facing only. */
  source: string;
  sourceRef: string;
  records: unknown[];
}

export interface Stored {
  id: string;
  /** Records the dataset holds now. */
  recordCount: number;
  /** Records this call added. */
  added: number;
  /** True when the result had more records than the dataset keeps. */
  truncated: boolean;
  fields: FieldStat[];
  /** The 1-based ordinal of this run within the dataset (1 for a new one). */
  run: number;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function typeOf(v: unknown): FieldType {
  if (typeof v === 'string') return 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'list';
  return 'object';
}

function sampleOf(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > SAMPLE_CHARS ? `${s.slice(0, SAMPLE_CHARS)}…` : s;
}

/** A record is an object; anything else is wrapped so it has a field. */
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { value: v };
}

/** The per-field shape of a set of records, from a sample of them. Fields
 *  are ordered by how often they carry a value, then by first appearance. */
function profileFields(records: unknown[]): FieldStat[] {
  const sample = records.slice(0, PROFILE_SAMPLE).map(asRecord);
  if (sample.length === 0) return [];
  const order: string[] = [];
  const acc = new Map<string, { types: Set<FieldType>; present: number; chars: number; items: number; sample?: string }>();
  for (const rec of sample) {
    for (const [name, value] of Object.entries(rec)) {
      let a = acc.get(name);
      if (!a) {
        a = { types: new Set(), present: 0, chars: 0, items: 0 };
        acc.set(name, a);
        order.push(name);
      }
      if (isEmptyValue(value)) continue;
      a.present += 1;
      const t = typeOf(value);
      a.types.add(t);
      if (t === 'text') a.chars += (value as string).length;
      if (t === 'list') a.items += (value as unknown[]).length;
      if (a.sample === undefined) a.sample = sampleOf(value);
    }
  }
  const stats: FieldStat[] = order.map((name) => {
    const a = acc.get(name)!;
    const type: FieldType = a.types.size === 1 ? [...a.types][0] : a.types.size === 0 ? 'text' : 'mixed';
    const stat: FieldStat = { name, type, present: Math.round((a.present / sample.length) * 100) / 100 };
    if (type === 'text' && a.present > 0) stat.avgChars = Math.round(a.chars / a.present);
    if (type === 'list' && a.present > 0) stat.avgItems = Math.round((a.items / a.present) * 10) / 10;
    if (a.sample !== undefined) stat.sample = a.sample;
    return stat;
  });
  return stats.sort((x, y) => y.present - x.present || order.indexOf(x.name) - order.indexOf(y.name));
}

/** Records within the dataset's bounds: the first ones that fit. */
function bounded(records: unknown[], alreadyKept: number, alreadyChars: number): { records: unknown[]; chars: number; truncated: boolean } {
  const room = MAX_DATASET_RECORDS - alreadyKept;
  let chars = 0;
  const kept: unknown[] = [];
  for (const r of records) {
    if (kept.length >= room) break;
    const size = JSON.stringify(r).length;
    if (alreadyChars + chars + size > MAX_DATASET_CHARS) break;
    kept.push(r);
    chars += size;
  }
  return { records: kept, chars, truncated: kept.length < records.length };
}

async function insertRecords(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  tenantId: string,
  datasetId: string,
  records: unknown[],
  firstOrdinal: number,
): Promise<void> {
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const batch = records.slice(i, i + INSERT_BATCH);
    const ordinals = batch.map((_, j) => firstOrdinal + i + j);
    await client.query(
      `INSERT INTO dataset_records (dataset_id, tenant_id, ordinal, record)
       SELECT $1, $2, o, r
         FROM unnest($3::int[], $4::jsonb[]) AS t(o, r)`,
      [datasetId, tenantId, ordinals, batch.map((r) => JSON.stringify(asRecord(r)))],
    );
  }
}

/** Park a result. Null when nothing could be kept (no records, or a store
 *  failure) — the caller then hands the model the rendering it has. */
export async function createDataset(tenantId: string, input: NewDataset): Promise<Stored | null> {
  const fit = bounded(input.records, 0, 0);
  if (fit.records.length === 0) return null;
  const fields = profileFields(fit.records);
  try {
    return await withTenantScope(tenantId, async (client) => {
      await client.query(`DELETE FROM datasets WHERE tenant_id = $1 AND expires_at < NOW()`, [tenantId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO datasets (tenant_id, scope_kind, scope_id, label, source, source_ref, record_count, bytes, fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING id`,
        [tenantId, input.scope.kind, input.scope.id, input.label, input.source, input.sourceRef,
          fit.records.length, fit.chars, JSON.stringify(fields)],
      );
      const id = r.rows[0]?.id;
      if (!id) return null;
      await insertRecords(client, tenantId, id, fit.records, 1);
      log.info(
        { event: 'dataset_created', tenantId, datasetId: id, scope: input.scope, source: input.source, sourceRef: input.sourceRef,
          records: fit.records.length, chars: fit.chars, truncated: fit.truncated },
        'fetched result parked as a dataset',
      );
      return { id, recordCount: fit.records.length, added: fit.records.length, truncated: fit.truncated, fields, run: 1 };
    });
  } catch (err) {
    log.warn({ tenantId, source: input.source, sourceRef: input.sourceRef, err: (err as Error).message },
      'dataset store: could not park the result; the model gets the rendering only');
    return null;
  }
}

/** Add a later run's records to a dataset of the same job. Each record gets
 *  `_run`, the 1-based ordinal of the run within the dataset, so a query can
 *  tell the runs apart. Null when the dataset is not this tenant's, has
 *  expired, or the store failed. */
export async function appendRecords(tenantId: string, datasetId: string, records: unknown[]): Promise<Stored | null> {
  if (!isDatasetId(datasetId)) return null;
  try {
    return await withTenantScope(tenantId, async (client) => {
      const cur = await client.query<{ record_count: number; bytes: string; fields: FieldStat[]; runs: number }>(
        `SELECT record_count, bytes, fields,
                (SELECT COALESCE(MAX((record->>'_run')::int), 0) FROM dataset_records WHERE dataset_id = d.id AND tenant_id = $1) AS runs
           FROM datasets d
          WHERE tenant_id = $1 AND id = $2 AND expires_at > NOW()
          FOR UPDATE`,
        [tenantId, datasetId],
      );
      const row = cur.rows[0];
      if (!row) return null;
      const runOrdinal = Number(row.runs) + 1;
      const tagged = records.map((r) => ({ ...asRecord(r), _run: runOrdinal }));
      const fit = bounded(tagged, row.record_count, Number(row.bytes));
      let fields: FieldStat[] = Array.isArray(row.fields) ? row.fields : [];
      if (fit.records.length > 0) {
        await insertRecords(client, tenantId, datasetId, fit.records, row.record_count + 1);
        fields = mergeFields(fields, profileFields(fit.records));
        await client.query(
          `UPDATE datasets
              SET record_count = record_count + $3,
                  bytes = bytes + $4,
                  fields = $5::jsonb,
                  updated_at = NOW()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, datasetId, fit.records.length, fit.chars, JSON.stringify(fields)],
        );
      }
      log.info(
        { event: 'dataset_appended', tenantId, datasetId, run: runOrdinal, records: fit.records.length, truncated: fit.truncated },
        'a later run added to a dataset',
      );
      return { id: datasetId, recordCount: row.record_count + fit.records.length, added: fit.records.length, truncated: fit.truncated, fields, run: runOrdinal };
    });
  } catch (err) {
    log.warn({ tenantId, datasetId, err: (err as Error).message }, 'dataset store: append failed');
    return null;
  }
}

/** The union of two profiles: a field known from either, its presence
 *  averaged, its sample from whichever had one first. */
function mergeFields(a: FieldStat[], b: FieldStat[]): FieldStat[] {
  const out = new Map<string, FieldStat>();
  for (const f of a) out.set(f.name, { ...f });
  for (const f of b) {
    const prev = out.get(f.name);
    if (!prev) {
      out.set(f.name, { ...f });
      continue;
    }
    const merged: FieldStat = {
      name: f.name,
      type: prev.type === f.type ? f.type : 'mixed',
      present: Math.round(((prev.present + f.present) / 2) * 100) / 100,
    };
    const avgChars = [prev.avgChars, f.avgChars].filter((n): n is number => typeof n === 'number');
    if (avgChars.length) merged.avgChars = Math.round(avgChars.reduce((s, n) => s + n, 0) / avgChars.length);
    const avgItems = [prev.avgItems, f.avgItems].filter((n): n is number => typeof n === 'number');
    if (avgItems.length) merged.avgItems = Math.round((avgItems.reduce((s, n) => s + n, 0) / avgItems.length) * 10) / 10;
    const sample = prev.sample ?? f.sample;
    if (sample !== undefined) merged.sample = sample;
    out.set(f.name, merged);
  }
  return [...out.values()];
}

export function isDatasetId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

interface DatasetRow {
  id: string;
  label: string;
  source: string;
  source_ref: string;
  record_count: number;
  bytes: string;
  fields: FieldStat[];
  created_at: Date;
  runs: number | string;
}

function toSummary(row: DatasetRow): DatasetSummary {
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    sourceRef: row.source_ref,
    recordCount: row.record_count,
    bytes: Number(row.bytes),
    fields: Array.isArray(row.fields) ? row.fields : [],
    createdAt: row.created_at,
    runs: Math.max(1, Number(row.runs) || 1),
  };
}

// The run count is the highest `_run` a record carries (an appended record
// is tagged with its run's ordinal; a first-run record carries none), read
// per dataset within the list's own bound of fifty.
const SUMMARY_COLUMNS = `id, label, source, source_ref, record_count, bytes, fields, created_at,
  (SELECT COALESCE(MAX((record->>'_run')::int), 1) FROM dataset_records dr WHERE dr.dataset_id = d.id AND dr.tenant_id = $1) AS runs`;

/** The datasets of one job: oldest first for the tool, which reads them in
 *  the order the work made them; newest first for the inventory a turn is
 *  shown, which keeps the most recent when it cannot show them all. */
export async function listDatasets(
  tenantId: string,
  scope: DatasetScope,
  opts: { order?: 'oldest' | 'newest' } = {},
): Promise<DatasetSummary[]> {
  const order = opts.order === 'newest' ? 'DESC' : 'ASC';
  try {
    return await withTenantScope(tenantId, async (client) => {
      const r = await client.query<DatasetRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM datasets d
          WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND expires_at > NOW()
          ORDER BY created_at ${order}
          LIMIT 50`,
        [tenantId, scope.kind, scope.id],
      );
      return r.rows.map(toSummary);
    });
  } catch (err) {
    log.warn({ tenantId, scope, err: (err as Error).message }, 'dataset store: list failed');
    return [];
  }
}
