// The dataset tools a model is offered wherever it can run a capability:
// the query, the extraction, and the list of what its job already holds.
// One dispatcher serves the in-process assistants and the internal route
// the Tenant Runtime and the workforce service call, so every surface reads
// the same words and gets the same bounds.

import type { JSONSchemaProperty, LLMToolDefinition } from '../llm/types';
import { log } from '../infrastructure/logging';
import { aggregateDatasets, DatasetQueryError, MAX_DISTINCT_VALUES, MAX_QUERY_LIMIT, QUERY_OPS, queryDatasets, type WhereClause } from './query';
import { DatasetExtractError, extractFromDataset, MAX_EXTRACT_GROUPS, MAX_EXTRACT_RECORDS } from './extract';
import { listDatasets, type DatasetScope } from './store';
import { renderAggregateResult, renderDatasetInventory, renderDatasetList, renderGroupedExtract, renderQueryResult } from './render';

const DATASET_QUERY_TOOL = 'dataset_query';
const DATASET_EXTRACT_TOOL = 'dataset_extract';
const DATASET_LIST_TOOL = 'dataset_list';

export const DATASET_TOOL_NAMES = [DATASET_QUERY_TOOL, DATASET_EXTRACT_TOOL, DATASET_LIST_TOOL] as const;
export type DatasetToolName = (typeof DATASET_TOOL_NAMES)[number];

const WHERE_SCHEMA: JSONSchemaProperty = {
  type: 'array',
  description: 'Filters, all of which a record must satisfy.',
  items: {
    type: 'object',
    properties: {
      field: { type: 'string', description: 'A field name from the dataset; a nested field as a.b' },
      op: { type: 'string', enum: [...QUERY_OPS], description: 'eq ne gt gte lt lte compare with value; contains is a case-insensitive text match; exists needs no value; in matches any of values' },
      value: { type: 'string', description: 'The value to compare with, written as text: a number as 12 or 3.5, true or false, null for an absent value' },
      values: { type: 'array', items: { type: 'string' }, description: 'For in: the values to match, each as text' },
    },
    required: ['field', 'op'],
  },
};

const datasetQueryTool: LLMToolDefinition = {
  name: DATASET_QUERY_TOOL,
  description:
    'Read rows from a dataset a fetch kept: name the fields you want, filter, sort and limit, and get exactly those fields for the matching '
    + 'records — small rows, any page, no model used and the fetch not charged again. Use this to pick the top records, to check a value, or to list a column; select only '
    + 'the fields you need (a long text field is shortened unless it is the only one selected). With aggregate, no rows are returned: '
    + '{ distinct: "field" } gives the field\'s distinct values with how many records carry each, and { count: true } with where gives the matching '
    + 'count alone — the cheap answer to "how many posts have over 100 comments" or "which authors appear most". For a question that needs the CONTENT of many '
    + 'records read — themes, a summary, what was said — use dataset_extract instead of paging.',
  input_schema: {
    type: 'object',
    properties: {
      datasetId: { type: 'string', description: 'The dataset id a fetch or dataset_list gave' },
      datasetIds: { type: 'array', items: { type: 'string' }, description: 'Several datasets to read together (each row then carries _dataset)' },
      select: { type: 'array', items: { type: 'string' }, description: 'Fields to return, e.g. ["title","score","url"]; every field when omitted' },
      where: WHERE_SCHEMA,
      sort: {
        type: 'object',
        properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['field'],
        description: 'Order of the rows; numbers sort as numbers, desc by default',
      },
      limit: { type: 'integer', description: `Rows to return, 1–${MAX_QUERY_LIMIT} (default 50)` },
      offset: { type: 'integer', description: 'Rows to skip, for the next page (the result names the next offset)' },
      aggregate: {
        type: 'object',
        description: `Compute over the matching records instead of returning rows: distinct lists a field's values with counts (the ${MAX_DISTINCT_VALUES} most frequent); count gives the matching count`,
        properties: {
          distinct: { type: 'string', description: 'A field name whose distinct values to count; a nested field as a.b' },
          count: { type: 'boolean', description: 'true for the number of matching records' },
        },
      },
    },
  },
};

const datasetExtractTool: LLMToolDefinition = {
  name: DATASET_EXTRACT_TOOL,
  description:
    'Answer an instruction over the records of a dataset without reading them yourself: the platform reads the selected records and returns '
    + 'one digest (themes, a summary, the answer to a question, counts by kind, quotes). Use it whenever the answer depends on the content of '
    + 'many records. Narrow with where/select/limit so it reads only what matters (for example the comments of the top twenty posts, not of '
    + `every post); at most ${MAX_EXTRACT_RECORDS} records per call. With saveAs, the instruction is applied to EACH record and the answers are `
    + 'kept as a new dataset you can query (for example "the main complaint in this comment" for every comment). With groupBy, the records are '
    + 'grouped by that field and the instruction is answered once PER GROUP in one call (for example "summarise the discussion" grouped by postId '
    + `gives one summary per post); at most ${MAX_EXTRACT_GROUPS} groups per call, every group's answer kept as a dataset {group, records, answer}, `
    + 'and saveAs then only names that dataset.',
  input_schema: {
    type: 'object',
    properties: {
      datasetId: { type: 'string', description: 'The dataset id a fetch or dataset_list gave' },
      instruction: { type: 'string', description: 'What to answer or extract from the records, in one or two sentences' },
      select: { type: 'array', items: { type: 'string' }, description: 'Fields to read; every field when omitted. Fewer fields read faster and cost less.' },
      where: WHERE_SCHEMA,
      limit: { type: 'integer', description: `Read at most this many records (in fetch order), up to ${MAX_EXTRACT_RECORDS}` },
      saveAs: { type: 'string', description: 'Name for a dataset of per-record answers, when you need one answer per record rather than one digest; with groupBy, the name of the dataset of per-group answers' },
      groupBy: { type: 'string', description: `A field name to group the records by (a nested field as a.b): one answer per group, at most ${MAX_EXTRACT_GROUPS} groups` },
    },
    required: ['datasetId', 'instruction'],
  },
};

const datasetListTool: LLMToolDefinition = {
  name: DATASET_LIST_TOOL,
  description:
    'List the datasets already kept for this work — each fetch whose result was larger than one message — with their ids, record counts and '
    + 'fields. Check here before fetching again: the fetch is not charged again; dataset_query and dataset_list use no model; dataset_extract '
    + 'uses the model and is metered like any answer.',
  input_schema: { type: 'object', properties: {} },
};

export const datasetTools: LLMToolDefinition[] = [datasetQueryTool, datasetExtractTool, datasetListTool];

export function isDatasetTool(name: string): name is DatasetToolName {
  return (DATASET_TOOL_NAMES as readonly string[]).includes(name);
}

export interface DatasetToolContext {
  /** The job the datasets belong to. */
  scope: DatasetScope;
  /** The usage purpose an extraction's model calls are attributed under. */
  purpose: string;
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  return out.length ? out : undefined;
}

/** A filter value as the model wrote it — text on the wire, so every
 *  vendor's schema accepts it — read back as the value it names: a number,
 *  true/false, null, or the text itself. */
function valueOf(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  return v;
}

function whereOf(v: unknown): WhereClause[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((w): w is Record<string, unknown> => w !== null && typeof w === 'object')
    .map((w) => {
      const op = String(w.op ?? '') as WhereClause['op'];
      const value = op === 'in'
        ? (Array.isArray(w.values) ? w.values : Array.isArray(w.value) ? w.value : typeof w.value === 'string' ? w.value.split(',').map((x) => x.trim()).filter(Boolean) : undefined)
        : valueOf(w.value);
      return { field: String(w.field ?? ''), op, value };
    });
}

function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Run one dataset tool for a model and return the text it reads. A bad
 *  input is answered with what to change; a failure with what to do next.
 *  Never throws. */
export async function runDatasetTool(
  tenantId: string,
  name: DatasetToolName,
  input: Record<string, unknown>,
  ctx: DatasetToolContext,
): Promise<string> {
  try {
    switch (name) {
      case DATASET_LIST_TOOL:
        // `inventory` is not the model's: the Tenant Runtime and the workforce
        // service ask for the block a turn is shown at its start (newest first,
        // budgeted, the same words the in-process assistant reads), so every
        // surface renders one inventory from one renderer.
        if (input.inventory === true) {
          return renderDatasetInventory(await listDatasets(tenantId, ctx.scope, { order: 'newest' }));
        }
        return renderDatasetList(await listDatasets(tenantId, ctx.scope));
      case DATASET_QUERY_TOOL: {
        const ids = [...(typeof input.datasetId === 'string' ? [input.datasetId] : []), ...(strings(input.datasetIds) ?? [])];
        const aggregate = input.aggregate && typeof input.aggregate === 'object' ? (input.aggregate as Record<string, unknown>) : undefined;
        if (aggregate && (typeof aggregate.distinct === 'string' || aggregate.count === true)) {
          const result = await aggregateDatasets(tenantId, { datasetIds: ids, where: whereOf(input.where) }, {
            ...(typeof aggregate.distinct === 'string' && aggregate.distinct.trim().length > 0 ? { distinct: aggregate.distinct.trim() } : {}),
            ...(aggregate.count === true ? { count: true } : {}),
          });
          return renderAggregateResult(result);
        }
        const select = strings(input.select);
        const sortField = input.sort && typeof input.sort === 'object' ? (input.sort as Record<string, unknown>).field : undefined;
        const sortDir = input.sort && typeof input.sort === 'object' ? (input.sort as Record<string, unknown>).dir : undefined;
        const result = await queryDatasets(tenantId, {
          datasetIds: ids,
          select,
          where: whereOf(input.where),
          sort: typeof sortField === 'string' ? { field: sortField, dir: sortDir === 'asc' ? 'asc' : 'desc' } : undefined,
          limit: intOf(input.limit),
          offset: intOf(input.offset),
        });
        return renderQueryResult(result, select);
      }
      case DATASET_EXTRACT_TOOL: {
        const out = await extractFromDataset(
          tenantId,
          {
            datasetId: String(input.datasetId ?? ''),
            instruction: String(input.instruction ?? ''),
            select: strings(input.select),
            where: whereOf(input.where),
            limit: intOf(input.limit),
            saveAs: typeof input.saveAs === 'string' ? input.saveAs : undefined,
            groupBy: typeof input.groupBy === 'string' ? input.groupBy : undefined,
          },
          ctx,
        );
        if (out.groups) return renderGroupedExtract(out.groups, out.derived, out.records);
        const derived = out.derived
          ? `\n\nThe per-record answers are kept as dataset ${out.derived.id} (${out.derived.recordCount} records; fields ordinal, answer) — query it with dataset_query.`
          : '';
        return `${out.digest}\n\n(Answered over ${out.records} records.)${derived}`;
      }
    }
  } catch (err) {
    if (err instanceof DatasetQueryError || err instanceof DatasetExtractError) return err.message;
    log.warn({ tenantId, tool: name, err: (err as Error).message }, 'dataset tool failed');
    return 'That could not be answered right now. Try a narrower query, or say plainly what could not be read.';
  }
  return 'Unknown dataset tool.';
}
