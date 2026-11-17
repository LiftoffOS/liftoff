// An instruction answered over a dataset's records, inside the platform.
//
// "What are people saying in the comments on these posts" is a question
// about thousands of records, and the model asking it must not read them:
// the answer is computed here instead. The selected records are cut into
// chunks, a small model answers the instruction for each chunk (in
// parallel, bounded), and one more call folds the chunk answers into a
// single digest. With `saveAs`, the chunk calls answer per record instead,
// and those answers become a derived dataset the model can query next.
// With `groupBy`, the records are grouped by a field's value and the
// instruction is answered once per group — "one summary per thread" is one
// call, not twenty — and every group's answer is kept as a derived dataset
// whether or not the reply can show them all. Every call is a model call
// like any other — attributed to the workspace under its own purpose, so
// the digest is paid for and the carrying is not.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import { queryDatasets, readFieldPath, type WhereClause } from './query';
import { createDataset, isDatasetId, type DatasetScope } from './store';

/** The most records one extraction reads. A wider selection is refused with
 *  the remedy (narrow it), not silently cut. */
export const MAX_EXTRACT_RECORDS = 2_000;
/** The most the selected records may serialize to. */
const MAX_EXTRACT_CHARS = 2_000_000;
/** Characters of records per chunk call. */
const CHUNK_CHARS = 40_000;
/** A text value fed to a chunk call is shortened past this. */
const RECORD_TEXT_CHARS = 4_000;
const CHUNKS_IN_FLIGHT = 4;
/** The digest the model gets back is at most this long. */
const DIGEST_CHARS = 3_000;
const MAP_MAX_TOKENS = 1_500;
const REDUCE_MAX_TOKENS = 1_200;
const PER_RECORD_MAX_TOKENS = 4_000;
/** Records per chunk in per-record mode: each needs its own answer, so a
 *  chunk holds fewer of them. */
const PER_RECORD_CHUNK = 40;
/** The most groups one grouped extraction answers: one small call each. A
 *  wider grouping is refused with the remedy, naming the groups that would
 *  have been taken. */
export const MAX_EXTRACT_GROUPS = 50;
/** The group a record with no value for the field falls into. */
const NO_VALUE_GROUP = '(none)';

export interface ExtractInput {
  datasetId: string;
  instruction: string;
  select?: string[];
  where?: WhereClause[];
  limit?: number;
  /** Name for a derived dataset. Without `groupBy` it is also the switch
   *  into per-record mode; with `groupBy` it only names the derived dataset
   *  of per-group answers, which is kept either way. */
  saveAs?: string;
  /** A field path: the records are grouped by its text value and the
   *  instruction is answered once per group. */
  groupBy?: string;
}

/** One group's answer, kept as a record of the derived dataset. */
export interface GroupAnswer {
  group: string;
  records: number;
  answer: string;
}

export interface ExtractOutcome {
  digest: string;
  /** Records the extraction read. */
  records: number;
  derived?: { id: string; recordCount: number };
  /** Grouped mode: every group's answer, ordered by group size. The reply
   *  renders as many as fit; the derived dataset holds them all. */
  groups?: GroupAnswer[];
}

export class DatasetExtractError extends Error {}

const MAP_SYSTEM =
  'You are given records (one JSON object per line, each with an _ordinal) and an instruction. Answer the instruction from the records only — '
  + 'be specific, keep names, numbers and quotes as they appear, and cite records by ordinal in brackets like [#17]. If the records do not '
  + 'contain what the instruction asks for, say so. Answer in plain prose or a short list; no preamble.';

const PER_RECORD_SYSTEM =
  'You are given records (one JSON object per line, each with an _ordinal) and an instruction to apply to EACH record. Reply with one line per '
  + 'record, in the form <ordinal>\t<answer>, where the answer is the instruction applied to that record only, from that record only. Keep each '
  + 'answer short. Do not skip a record; if it holds nothing relevant, answer "none". No other text.';

const REDUCE_SYSTEM =
  'You are given partial answers to one instruction, each computed over a different part of the same set of records, and the instruction itself. '
  + 'Combine them into one answer to the instruction: merge repeated points, keep the specifics (names, numbers, quotes) and the record citations '
  + 'like [#17], and drop nothing that is distinct. Plain prose or a short list; no preamble; at most about 2,500 characters.';

function shorten(v: unknown): unknown {
  if (typeof v === 'string') return v.length > RECORD_TEXT_CHARS ? `${v.slice(0, RECORD_TEXT_CHARS)}…` : v;
  if (Array.isArray(v)) return v.map(shorten);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null || x === undefined || x === '') continue;
      out[k] = shorten(x);
    }
    return out;
  }
  return v;
}

function lineOf(row: Record<string, unknown>): string {
  return JSON.stringify(shorten(row));
}

/** Records cut into chunks of at most CHUNK_CHARS (or, per record, at most
 *  PER_RECORD_CHUNK records). */
function chunkLines(lines: string[], perRecord: boolean): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const line of lines) {
    const over = perRecord ? cur.length >= PER_RECORD_CHUNK : used + line.length + 1 > CHUNK_CHARS;
    if (cur.length > 0 && over) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(line);
    used += line.length + 1;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

async function mapChunks<T>(chunks: string[][], f: (chunk: string[], i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(chunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const i = next++;
      out[i] = await f(chunks[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNKS_IN_FLIGHT, chunks.length) }, worker));
  return out;
}

/** The per-record lines a chunk answered, parsed leniently. */
function parsePerRecord(text: string): Array<{ ordinal: number; answer: string }> {
  const out: Array<{ ordinal: number; answer: string }> = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*#?(\d+)\s*[\t:|-]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const answer = m[2].trim();
    if (!answer) continue;
    out.push({ ordinal: Number(m[1]), answer });
  }
  return out;
}

/** The text value a record carries for the group field, the way the query
 *  reads it (`record #>> path`): a primitive as text, an object or list as
 *  its JSON, nothing as the no-value group. The row is read by the path as
 *  written when the selection projected it, else by walking the record. */
function groupKeyOf(row: Record<string, unknown>, field: string): string {
  const v = field in row ? row[field] : readFieldPath(row, field);
  if (v === null || v === undefined || v === '') return NO_VALUE_GROUP;
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** One instruction over one group's records: one small call when the group
 *  fits a chunk, a map over its chunks and one fold when it does not — the
 *  same shape as a whole-selection digest, within the group. */
async function answerGroup(
  instruction: string,
  lines: string[],
  usage: { tenantId: string; purpose: string },
): Promise<string> {
  const chunks = chunkLines(lines, false);
  const partials = await mapChunks(chunks, async (chunk) => {
    const res = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: MAP_SYSTEM },
          { role: 'user', content: `Instruction: ${instruction}\n\nRecords:\n${chunk.join('\n')}` },
        ],
        tier: 'small',
        maxTokens: MAP_MAX_TOKENS,
        temperature: 0,
      },
      undefined,
      usage,
    );
    return res.content.trim();
  });
  if (partials.length === 1) return partials[0];
  const res = await llmClient.complete(
    {
      messages: [
        { role: 'system', content: REDUCE_SYSTEM },
        { role: 'user', content: `Instruction: ${instruction}\n\nPartial answers:\n${partials.map((p, i) => `--- part ${i + 1} ---\n${p}`).join('\n')}` },
      ],
      tier: 'small',
      maxTokens: REDUCE_MAX_TOKENS,
      temperature: 0,
    },
    undefined,
    usage,
  );
  return res.content.trim();
}

export async function extractFromDataset(
  tenantId: string,
  input: ExtractInput,
  ctx: { scope: DatasetScope; purpose: string },
): Promise<ExtractOutcome> {
  if (!isDatasetId(input.datasetId)) throw new DatasetExtractError('datasetId must be the id a fetch or dataset_list gave.');
  const instruction = input.instruction.trim();
  if (!instruction) throw new DatasetExtractError('instruction is required: what to answer or extract from the records.');
  const limit = Math.min(MAX_EXTRACT_RECORDS, Math.max(1, Math.floor(input.limit ?? MAX_EXTRACT_RECORDS)));
  const groupBy = typeof input.groupBy === 'string' && input.groupBy.trim().length > 0 ? input.groupBy.trim() : undefined;
  // The group field has to be read off every row, so a selection that names
  // fields names it too.
  const select = groupBy && input.select && input.select.length > 0 && !input.select.includes(groupBy)
    ? [...input.select, groupBy]
    : input.select;

  // The selection, whole: the query bounds a page at 200, so it is walked.
  const rows: Array<Record<string, unknown>> = [];
  let chars = 0;
  for (let offset = 0; rows.length < limit; offset += 200) {
    const page = await queryDatasets(tenantId, {
      datasetIds: [input.datasetId], select, where: input.where, limit: Math.min(200, limit - rows.length), offset,
    });
    if (offset === 0 && page.total > limit && input.limit === undefined) {
      throw new DatasetExtractError(`${page.total} records match, more than the ${MAX_EXTRACT_RECORDS} one extraction reads; filter with where, or pass a limit to read the first ones.`);
    }
    for (const row of page.rows) {
      chars += JSON.stringify(row).length;
      if (chars > MAX_EXTRACT_CHARS) {
        throw new DatasetExtractError(`The selected records are over ${Math.round(MAX_EXTRACT_CHARS / 1000)}k characters; select fewer fields, filter with where, or lower the limit.`);
      }
      rows.push(row);
    }
    if (page.rows.length < page.limit) break;
  }
  if (rows.length === 0) return { digest: 'No records match the selection; nothing to extract from.', records: 0 };

  const usage = { tenantId, purpose: ctx.purpose };
  const started = Date.now();

  // Grouped mode. `groupBy` alone selects it; `saveAs` only names the derived
  // dataset here and never switches to per record.
  if (groupBy) {
    const byGroup = new Map<string, string[]>();
    for (const row of rows) {
      const key = groupKeyOf(row, groupBy);
      const lines = byGroup.get(key);
      if (lines) lines.push(lineOf(row));
      else byGroup.set(key, [lineOf(row)]);
    }
    // Ordered by size, the largest first: what the reply shows when it cannot
    // show every group is the groups that hold the most records.
    const ordered = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (ordered.length > MAX_EXTRACT_GROUPS) {
      const named = ordered.slice(0, MAX_EXTRACT_GROUPS).map(([k]) => k).join(', ');
      throw new DatasetExtractError(
        `${ordered.length} groups of ${groupBy}, more than the ${MAX_EXTRACT_GROUPS} one extraction answers; narrow with where, or pass limit to read fewer records. `
        + `The first ${MAX_EXTRACT_GROUPS} groups by size are ${named}.`,
      );
    }
    // One small call per group (a larger group is mapped and folded within
    // itself), four groups in flight as chunks are.
    const answers = await mapChunks(ordered.map(([, lines]) => lines), (lines) => answerGroup(instruction, lines, usage));
    const groups: GroupAnswer[] = ordered.map(([group, lines], i) => ({ group, records: lines.length, answer: answers[i] }));
    // Every group's answer is kept, whether or not the reply can show it.
    const label = (typeof input.saveAs === 'string' && input.saveAs.trim().length > 0 ? input.saveAs.trim() : `${instruction} by ${groupBy}`).slice(0, 120);
    const stored = await createDataset(tenantId, {
      scope: ctx.scope, label, source: 'derived', sourceRef: `dataset:${input.datasetId}`, records: groups,
    });
    const derived = stored ? { id: stored.id, recordCount: stored.recordCount } : undefined;
    log.info(
      { event: 'dataset_extracted', tenantId, datasetId: input.datasetId, records: rows.length, groups: groups.length, groupBy,
        derived: derived?.id ?? null, latencyMs: Date.now() - started, purpose: ctx.purpose },
      'an instruction was answered per group over a dataset',
    );
    return { digest: '', records: rows.length, groups, ...(derived ? { derived } : {}) };
  }

  const perRecord = typeof input.saveAs === 'string' && input.saveAs.trim().length > 0;
  const chunks = chunkLines(rows.map(lineOf), perRecord);

  const answers = await mapChunks(chunks, async (chunk) => {
    const res = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: perRecord ? PER_RECORD_SYSTEM : MAP_SYSTEM },
          { role: 'user', content: `Instruction: ${instruction}\n\nRecords:\n${chunk.join('\n')}` },
        ],
        tier: 'small',
        maxTokens: perRecord ? PER_RECORD_MAX_TOKENS : MAP_MAX_TOKENS,
        temperature: 0,
      },
      undefined,
      usage,
    );
    return res.content.trim();
  });

  let derived: ExtractOutcome['derived'];
  let partials = answers;
  if (perRecord) {
    const byOrdinal = new Map<number, string>();
    for (const a of answers) for (const p of parsePerRecord(a)) byOrdinal.set(p.ordinal, p.answer);
    const records = rows
      .map((row) => ({ ordinal: row._ordinal as number, answer: byOrdinal.get(row._ordinal as number) ?? 'none' }))
      .filter((r) => r.answer !== 'none');
    const stored = records.length
      ? await createDataset(tenantId, {
          scope: ctx.scope, label: input.saveAs!.trim().slice(0, 120), source: 'derived', sourceRef: `dataset:${input.datasetId}`, records,
        })
      : null;
    if (stored) derived = { id: stored.id, recordCount: stored.recordCount };
    // The digest is folded from the per-record answers, a chunk at a time.
    partials = chunkLines(records.map((r) => `[#${r.ordinal}] ${r.answer}`), false).map((c) => c.join('\n'));
  }

  let digest: string;
  if (partials.length === 1 && !perRecord) {
    digest = partials[0];
  } else {
    const res = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: REDUCE_SYSTEM },
          { role: 'user', content: `Instruction: ${instruction}\n\nPartial answers:\n${partials.map((p, i) => `--- part ${i + 1} ---\n${p}`).join('\n')}` },
        ],
        tier: 'small',
        maxTokens: REDUCE_MAX_TOKENS,
        temperature: 0,
      },
      undefined,
      usage,
    );
    digest = res.content.trim();
  }
  if (digest.length > DIGEST_CHARS) digest = `${digest.slice(0, DIGEST_CHARS)}…`;

  log.info(
    { event: 'dataset_extracted', tenantId, datasetId: input.datasetId, records: rows.length, chunks: chunks.length, perRecord,
      derived: derived?.id ?? null, latencyMs: Date.now() - started, purpose: ctx.purpose },
    'an instruction was answered over a dataset',
  );
  return { digest, records: rows.length, ...(derived ? { derived } : {}) };
}
