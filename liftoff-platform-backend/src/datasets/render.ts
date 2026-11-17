// What a model reads about a dataset: the view it gets in place of a large
// result, the rows a query returns, the list of a job's datasets. Every
// rendering here is bounded by construction and says what it left out.

import type { DatasetSummary, FieldStat } from './store';
import type { AggregateResult, QueryResult } from './query';
import type { GroupAnswer } from './extract';

/** Characters of query rows one call hands the model. */
const QUERY_RENDER_BUDGET = 12_000;
/** A text value in a row is shortened past this, unless it is the only
 *  field asked for — then the field is what was wanted, and it gets room. */
const ROW_TEXT_CHARS = 240;
const SOLE_FIELD_TEXT_CHARS = 4_000;
/** Fields the view names in full; the rest are listed by name. */
const VIEW_FIELDS_IN_FULL = 12;
/** Characters of sample records the view carries. */
const VIEW_SAMPLE_CHARS = 1_200;
const VIEW_SAMPLE_TEXT_CHARS = 160;

function kchars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k chars` : `${n} chars`;
}

function describeField(f: FieldStat): string {
  const parts: string[] = [f.type];
  if (f.type === 'text' && typeof f.avgChars === 'number' && f.avgChars >= 200) parts.push(`avg ${kchars(f.avgChars)}`);
  if (f.type === 'list' && typeof f.avgItems === 'number') parts.push(`avg ${f.avgItems} items`);
  if (f.present < 0.5) parts.push(`in ${Math.round(f.present * 100)}%`);
  return `${f.name} (${parts.join(', ')})`;
}

/** Field list for the model: the ones that carry a value most often, with
 *  their shape, and the rest by name. */
function renderFields(fields: FieldStat[]): string {
  if (fields.length === 0) return 'no named fields';
  const named = fields.filter((f) => f.name !== '_run');
  const head = named.slice(0, VIEW_FIELDS_IN_FULL).map(describeField);
  const tail = named.slice(VIEW_FIELDS_IN_FULL).map((f) => f.name);
  const runs = fields.some((f) => f.name === '_run') ? '; _run (number: which run added the record)' : '';
  return `${head.join(', ')}${tail.length ? `; also ${tail.join(', ')}` : ''}${runs}`;
}

/** A value shortened for a row or a sample. */
function shortValue(v: unknown, textChars: number): unknown {
  if (typeof v === 'string') return v.length > textChars ? `${v.slice(0, textChars)}…[+${v.length - textChars} chars]` : v;
  if (Array.isArray(v)) {
    const s = JSON.stringify(v);
    return s.length > textChars ? `[list of ${v.length}]` : v;
  }
  if (v !== null && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > textChars ? `{object, ${kchars(s.length)}}` : v;
  }
  return v;
}

function renderRecord(rec: Record<string, unknown>, textChars: number): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = shortValue(v, textChars);
  }
  return JSON.stringify(out);
}

function withinBudget(items: string[], budget: number): { text: string; shown: number } {
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    if (used + it.length + 1 > budget) break;
    lines.push(it);
    used += it.length + 1;
  }
  return { text: lines.join('\n'), shown: lines.length };
}

export interface ViewInput {
  id: string;
  label: string;
  recordCount: number;
  /** True when the result had more records than the dataset keeps. */
  truncated: boolean;
  fields: FieldStat[];
  sample: unknown[];
}

/** The view a model gets in place of a large result: what was kept, its
 *  shape, two records to see it by, and how to ask for what it needs. */
export function renderDatasetView(v: ViewInput): string {
  const sample = withinBudget(
    v.sample.map((r) => renderRecord(r as Record<string, unknown>, VIEW_SAMPLE_TEXT_CHARS)),
    VIEW_SAMPLE_CHARS,
  );
  const kept = v.truncated
    ? `The first ${v.recordCount} records of a larger result were fetched and kept`
    : `${v.recordCount} records were fetched and kept`;
  return [
    `${kept} as dataset ${v.id} ("${v.label}"). Fields: ${renderFields(v.fields)}.`,
    sample.shown > 0 ? `Sample (${sample.shown} of ${v.recordCount}, long values shortened):\n${sample.text}` : '',
    'The fetch is not charged again. To use the records: dataset_query returns the fields you name, filtered, sorted and limited (small rows, any page; no model used); '
    + 'dataset_extract answers an instruction over the records (themes, a summary, a per-record extraction) without you reading them (it uses the model and is metered like any answer). '
    + 'Do not try to read every record, and do not run the capability again for records it already returned.',
  ].filter(Boolean).join('\n\n');
}

/** Query rows, one JSON object a line, within the budget; the trailer says
 *  which rows these are of the total and how to get the next. */
export function renderQueryResult(r: QueryResult, select: string[] | undefined): string {
  if (r.total === 0) return 'No records match. Check the field names against the dataset\'s fields, or loosen the filters.';
  const sole = select && select.length === 1;
  const items = r.rows.map((row) => renderRecord(row, sole ? SOLE_FIELD_TEXT_CHARS : ROW_TEXT_CHARS));
  const fit = withinBudget(items, QUERY_RENDER_BUDGET);
  if (fit.shown === 0) return 'The first row alone is over the size one call returns; select fewer or shorter fields.';
  const from = r.offset + 1;
  const to = r.offset + fit.shown;
  const cut = fit.shown < r.rows.length ? ` (${r.rows.length - fit.shown} of this page left out for length — ask for fewer fields or a smaller limit)` : '';
  const next = to < r.total ? ` Next: offset ${to}.` : ' That is every match.';
  return `${fit.text}\n\nRows ${from}–${to} of ${r.total} matching records${cut}.${next}`;
}

/** A grouped extraction's answers, one line a group within the row budget,
 *  largest groups first; the trailer says how many were left out and names
 *  the derived dataset that holds every one. */
export function renderGroupedExtract(
  groups: GroupAnswer[],
  derived: { id: string; recordCount: number } | undefined,
  records: number,
): string {
  const items = groups.map((g) => `- ${g.group} (${g.records} record${g.records === 1 ? '' : 's'}): ${g.answer}`);
  const fit = withinBudget(items, QUERY_RENDER_BUDGET);
  const shown = fit.shown === 0 && items.length > 0 ? 0 : fit.shown;
  const leftOut = groups.length - shown;
  const kept = derived
    ? `Every group's answer is kept as dataset ${derived.id} (${derived.recordCount} records; fields group, records, answer) — query it with dataset_query.`
    : 'The answers could not be kept as a dataset this time.';
  const trailer = leftOut > 0
    ? `${shown} of ${groups.length} groups shown; ${leftOut} left out for length. ${kept}`
    : `${groups.length} group${groups.length === 1 ? '' : 's'}, answered over ${records} records. ${kept}`;
  return shown > 0 ? `${fit.text}\n\n${trailer}` : trailer;
}

/** An aggregate, for dataset_query: the count, and the distinct values with
 *  their counts, most frequent first. */
export function renderAggregateResult(r: AggregateResult): string {
  const parts: string[] = [];
  if (typeof r.count === 'number') parts.push(`${r.count} matching record${r.count === 1 ? '' : 's'}.`);
  if (r.distinct) {
    if (r.distinct.values.length === 0) {
      parts.push(`No records match, so ${r.distinct.field} has no values here.`);
    } else {
      const lines = r.distinct.values.map((v) => `${v.value === null ? '(none)' : JSON.stringify(v.value)}: ${v.count}`);
      parts.push(`Distinct values of ${r.distinct.field} (${r.distinct.values.length}, most frequent first):\n${lines.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

/** Tokens the inventory a turn is shown may take (4 characters a token, the
 *  context budget's own rule); the section's cap is the same figure. */
export const DATASET_INVENTORY_BUDGET_TOKENS = 700;

/** The words every surface reads above its inventory: what is kept, how to
 *  read it, and what is and is not charged (the same words the tools carry). */
const INVENTORY_HEADER =
  'Datasets kept for this conversation. Read them with dataset_query (uses no model) or dataset_extract (uses the model and is metered like '
  + 'any answer); the fetch is not charged again, and dataset_list uses no model.';

function inventoryLine(d: DatasetSummary): string {
  const runs = d.runs > 1 ? `, ${d.runs} runs` : '';
  return `- ${d.id} "${d.label}" — ${d.recordCount} records${runs}; fields ${renderFields(d.fields)}`;
}

/**
 * The inventory a turn is shown at its start: the job's datasets, NEWEST
 * first (the list must arrive in that order), as many as fit the budget,
 * with a trailer that says only what dataset_list can return. Empty when the
 * job holds none, so a conversation with no datasets carries no section.
 */
export function renderDatasetInventory(
  newestFirst: DatasetSummary[],
  budgetTokens: number = DATASET_INVENTORY_BUDGET_TOKENS,
): string {
  if (!Array.isArray(newestFirst) || newestFirst.length === 0) return '';
  const budgetChars = budgetTokens * 4;
  const lines: string[] = [];
  let used = INVENTORY_HEADER.length + 1;
  for (const d of newestFirst) {
    const line = inventoryLine(d);
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  // The most recent dataset is shown even when it alone is over the budget:
  // an inventory that names none is worse than a long line.
  if (lines.length === 0) lines.push(inventoryLine(newestFirst[0]));
  const older = newestFirst.length - lines.length;
  const trailer = older > 0 ? `\n+${older} older dataset${older === 1 ? '' : 's'}; dataset_list lists them.` : '';
  return `${INVENTORY_HEADER}\n${lines.join('\n')}${trailer}`;
}

/** A job's datasets, for dataset_list. */
export function renderDatasetList(list: DatasetSummary[]): string {
  if (list.length === 0) return 'No datasets are kept for this conversation yet. A fetch whose result is larger than one message is kept as one.';
  return list
    .map((d) => `- ${d.id} "${d.label}": ${d.recordCount} records; fields ${renderFields(d.fields)}`)
    .join('\n');
}
