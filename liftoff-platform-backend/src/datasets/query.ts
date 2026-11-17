// A question put to a dataset's records, answered from the rows.
//
// The model names the fields it wants, the records it wants (filters), the
// order and how many, and gets back rows of exactly those fields — a page of
// a hundred records with four fields each is a few hundred tokens, where the
// records themselves would be a hundred kilobytes. The query language is a
// fixed shape: a field is a path into the record, an operator is one of a
// short list, a value is the model's. It is compiled to parameterised SQL
// over the jsonb column here, and nothing the model writes reaches the
// statement text.
//
// An aggregate answers the questions that would otherwise cost a page read:
// a field's distinct values with their counts, or the matching count alone.
// Both are one statement over the rows, no model.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { isDatasetId } from './store';

export const QUERY_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'in'] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export interface WhereClause {
  field: string;
  op: QueryOp;
  value?: unknown;
}

export interface DatasetQuery {
  datasetIds: string[];
  /** Fields (paths) to return; every top-level field when absent. */
  select?: string[];
  where?: WhereClause[];
  sort?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

/** What to compute over the matching records instead of returning rows:
 *  a field's distinct text values with how many records carry each, or the
 *  matching count alone. */
export interface DatasetAggregate {
  distinct?: string;
  count?: boolean;
}

export interface AggregateResult {
  /** The field's distinct values, most frequent first; null for records
   *  with no value. At most MAX_DISTINCT_VALUES. */
  distinct?: { field: string; values: Array<{ value: string | null; count: number }> };
  /** The matching count. */
  count?: number;
}

export interface QueryResult {
  /** The selected fields of each matching record, plus `_ordinal` (its
   *  place in the dataset) and, over several datasets, `_dataset`. */
  rows: Array<Record<string, unknown>>;
  /** Matching records across the datasets, before limit and offset. */
  total: number;
  offset: number;
  limit: number;
}

export const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_WHERE = 10;
const MAX_SELECT = 30;
const MAX_IN_VALUES = 100;
/** Distinct values one aggregate returns, most frequent first. */
export const MAX_DISTINCT_VALUES = 200;

/** A field path: `score`, `author.name`, `comments.0.body`. */
const FIELD_RE = /^[A-Za-z0-9_$-]{1,80}(\.[A-Za-z0-9_$-]{1,80}){0,5}$/;

export class DatasetQueryError extends Error {}

function pathOf(field: string): string[] {
  if (!FIELD_RE.test(field)) throw new DatasetQueryError(`"${field}" is not a field name; use the field names the dataset lists (a nested field as a.b).`);
  return field.split('.');
}

interface Compiled {
  sql: string;
  params: unknown[];
}

/** WHERE clauses over `record`, parameterised. A text comparison is on the
 *  field's text; a numeric one is guarded so a text value never fails the
 *  cast. `contains` is a case-insensitive substring match; `exists` is a
 *  value that is present and not empty. */
function compileWhere(where: WhereClause[], params: unknown[]): string[] {
  if (where.length > MAX_WHERE) throw new DatasetQueryError(`at most ${MAX_WHERE} filters`);
  const out: string[] = [];
  for (const w of where) {
    if (!QUERY_OPS.includes(w.op)) throw new DatasetQueryError(`"${w.op}" is not a filter operator; use one of ${QUERY_OPS.join(', ')}.`);
    const path = pathOf(w.field);
    const p = params.push(path);
    const text = `(record #>> $${p}::text[])`;
    const json = `(record #> $${p}::text[])`;
    switch (w.op) {
      case 'exists':
        out.push(`(${json} IS NOT NULL AND jsonb_typeof(${json}) <> 'null' AND ${text} <> '' AND ${json} <> '[]'::jsonb AND ${json} <> '{}'::jsonb)`);
        break;
      case 'contains': {
        if (typeof w.value !== 'string' || w.value.length === 0) throw new DatasetQueryError('"contains" takes a text value.');
        const v = params.push(w.value);
        out.push(`(${text} ILIKE '%' || $${v} || '%')`);
        break;
      }
      case 'in': {
        if (!Array.isArray(w.value) || w.value.length === 0 || w.value.length > MAX_IN_VALUES) throw new DatasetQueryError(`"in" takes a list of 1–${MAX_IN_VALUES} values.`);
        const v = params.push(w.value.map((x) => String(x)));
        out.push(`(${text} = ANY($${v}::text[]))`);
        break;
      }
      case 'eq':
      case 'ne': {
        const not = w.op === 'ne' ? 'NOT ' : '';
        if (typeof w.value === 'number') {
          const v = params.push(w.value);
          out.push(`${not}(jsonb_typeof(${json}) = 'number' AND ${text}::numeric = $${v})`);
        } else if (typeof w.value === 'boolean') {
          const v = params.push(w.value);
          out.push(`${not}(${json} = to_jsonb($${v}::boolean))`);
        } else if (w.value === null) {
          out.push(`${not}(${json} IS NULL OR jsonb_typeof(${json}) = 'null')`);
        } else {
          const v = params.push(String(w.value));
          out.push(`${not}(${text} = $${v})`);
        }
        break;
      }
      default: {
        // gt gte lt lte
        const cmp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[w.op];
        if (typeof w.value === 'number') {
          const v = params.push(w.value);
          out.push(`(jsonb_typeof(${json}) = 'number' AND ${text}::numeric ${cmp} $${v})`);
        } else if (typeof w.value === 'string' && w.value.length > 0) {
          const v = params.push(w.value);
          out.push(`(${text} ${cmp} $${v})`);
        } else {
          throw new DatasetQueryError(`"${w.op}" takes a number or a text value.`);
        }
      }
    }
  }
  return out;
}

/** ORDER BY: numbers as numbers, then the rest as text, absent values last,
 *  and fetch order within ties. */
function compileSort(sort: DatasetQuery['sort'] | undefined, params: unknown[]): string {
  if (!sort) return 'r.dataset_id, r.ordinal';
  const path = pathOf(sort.field);
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  const p = params.push(path);
  return `(CASE WHEN jsonb_typeof(record #> $${p}::text[]) = 'number' THEN (record #>> $${p}::text[])::numeric END) ${dir} NULLS LAST, `
    + `(record #>> $${p}::text[]) ${dir} NULLS LAST, r.dataset_id, r.ordinal`;
}

/** The statement for a query: rows of `dataset_id, ordinal, record` plus the
 *  total over the window. */
function compileQuery(tenantId: string, q: DatasetQuery): Compiled {
  const ids = q.datasetIds.filter(isDatasetId);
  if (ids.length === 0 || ids.length !== q.datasetIds.length) throw new DatasetQueryError('datasetId must be the id a fetch or dataset_list gave.');
  const params: unknown[] = [tenantId, ids];
  const where = compileWhere(q.where ?? [], params);
  const order = compileSort(q.sort, params);
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(q.limit ?? DEFAULT_QUERY_LIMIT)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const l = params.push(limit);
  const o = params.push(offset);
  const sql =
    `SELECT r.dataset_id, r.ordinal, r.record, COUNT(*) OVER () AS total
       FROM dataset_records r
      WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[])${where.length ? ` AND ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
      LIMIT $${l} OFFSET $${o}`;
  return { sql, params };
}

/** The count alone, for a page past the end: an offset beyond the last
 *  record returns no rows, and the window's total goes with them. */
function compileCount(tenantId: string, q: Pick<DatasetQuery, 'datasetIds' | 'where'>): Compiled {
  const params: unknown[] = [tenantId, q.datasetIds];
  const where = compileWhere(q.where ?? [], params);
  return {
    sql: `SELECT COUNT(*)::text AS total FROM dataset_records r
      WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[])${where.length ? ` AND ${where.join(' AND ')}` : ''}`,
    params,
  };
}

function readPath(record: unknown, path: string[]): unknown {
  let cur: unknown = record;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** A field's value read off a record by its path, validated the way the
 *  query validates a field. */
export function readFieldPath(record: unknown, field: string): unknown {
  return readPath(record, pathOf(field));
}

/** The selected fields of a record, keyed by the path as written. */
function project(record: unknown, select: string[] | undefined): Record<string, unknown> {
  if (!select || select.length === 0) {
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? { ...(record as Record<string, unknown>) } : { value: record };
  }
  const out: Record<string, unknown> = {};
  for (const field of select) out[field] = readPath(record, pathOf(field));
  return out;
}

/** The statements for an aggregate: `record #>> path` grouped and counted,
 *  or the count alone. */
function compileAggregate(tenantId: string, q: Pick<DatasetQuery, 'datasetIds' | 'where'>, agg: DatasetAggregate): { distinct?: Compiled; count?: Compiled } {
  const ids = q.datasetIds.filter(isDatasetId);
  if (ids.length === 0 || ids.length !== q.datasetIds.length) throw new DatasetQueryError('datasetId must be the id a fetch or dataset_list gave.');
  const out: { distinct?: Compiled; count?: Compiled } = {};
  if (typeof agg.distinct === 'string' && agg.distinct.trim().length > 0) {
    const params: unknown[] = [tenantId, ids];
    const where = compileWhere(q.where ?? [], params);
    const p = params.push(pathOf(agg.distinct.trim()));
    const l = params.push(MAX_DISTINCT_VALUES);
    out.distinct = {
      sql: `SELECT (record #>> $${p}::text[]) AS k, COUNT(*)::text AS n
              FROM dataset_records r
             WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[])${where.length ? ` AND ${where.join(' AND ')}` : ''}
             GROUP BY k
             ORDER BY 2 DESC, k ASC NULLS LAST
             LIMIT $${l}`,
      params,
    };
  }
  if (agg.count === true) {
    out.count = compileCount(tenantId, { datasetIds: ids, where: q.where });
  }
  if (!out.distinct && !out.count) throw new DatasetQueryError('aggregate needs distinct (a field) or count (true).');
  return out;
}

/** An aggregate over the matching records: distinct values with counts, the
 *  count alone, or both. No page is read and no model runs. */
export async function aggregateDatasets(
  tenantId: string,
  q: Pick<DatasetQuery, 'datasetIds' | 'where'>,
  agg: DatasetAggregate,
): Promise<AggregateResult> {
  const compiled = compileAggregate(tenantId, q, agg);
  try {
    return await withTenantScope(tenantId, async (client) => {
      const result: AggregateResult = {};
      if (compiled.distinct) {
        const r = await client.query<{ k: string | null; n: string }>(compiled.distinct.sql, compiled.distinct.params);
        result.distinct = {
          field: agg.distinct!.trim(),
          values: r.rows.map((row) => ({ value: row.k, count: Number(row.n) })),
        };
      }
      if (compiled.count) {
        const c = await client.query<{ total: string }>(compiled.count.sql, compiled.count.params);
        result.count = Number(c.rows[0]?.total ?? 0);
      }
      return result;
    });
  } catch (err) {
    log.warn({ tenantId, datasetIds: q.datasetIds, err: (err as Error).message }, 'dataset aggregate failed');
    throw new DatasetQueryError('The aggregate could not be run; check the field name and filters and try again.');
  }
}

export async function queryDatasets(tenantId: string, q: DatasetQuery): Promise<QueryResult> {
  if ((q.select ?? []).length > MAX_SELECT) throw new DatasetQueryError(`at most ${MAX_SELECT} fields`);
  const compiled = compileQuery(tenantId, q);
  const many = new Set(q.datasetIds).size > 1;
  try {
    return await withTenantScope(tenantId, async (client) => {
      const r = await client.query<{ dataset_id: string; ordinal: number; record: unknown; total: string }>(compiled.sql, compiled.params);
      const offset = compiled.params[compiled.params.length - 1] as number;
      let total = r.rows.length ? Number(r.rows[0].total) : 0;
      if (r.rows.length === 0 && offset > 0) {
        const count = compileCount(tenantId, q);
        const c = await client.query<{ total: string }>(count.sql, count.params);
        total = Number(c.rows[0]?.total ?? 0);
      }
      const rows = r.rows.map((row) => ({
        _ordinal: row.ordinal,
        ...(many ? { _dataset: row.dataset_id } : {}),
        ...project(row.record, q.select),
      }));
      return {
        rows,
        total,
        offset,
        limit: compiled.params[compiled.params.length - 2] as number,
      };
    });
  } catch (err) {
    log.warn({ tenantId, datasetIds: q.datasetIds, err: (err as Error).message }, 'dataset query failed');
    throw new DatasetQueryError('The query could not be run; check the field names and filters and try again.');
  }
}
