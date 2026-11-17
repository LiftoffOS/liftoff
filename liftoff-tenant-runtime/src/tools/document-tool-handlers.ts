/**
 * Document Tool Handlers — Standard Tool Layer
 *
 * Two extractors, and the difference between them is the fan-out.
 *
 * `handleTabularExtract` produces ONE row per document: the columns are known
 * before anything is read, so it calls the LLM once per column in parallel and
 * assembles the answers positionally.
 *
 * `handleTabularEnumerate` produces MANY rows per document — one per condition
 * precedent, per covenant, per obligation. The column list is still fixed, but
 * the row COUNT is not knowable until the document has been read, so the
 * fan-out inverts: a single call reads the document once and returns an array,
 * because no amount of per-column parallelism can discover how many rows there
 * are.
 */
import { llmClient } from '../llm/client';
import { getEntitlementsClient } from '../entitlements-client/service';
import { logger } from '../infrastructure/logging';
import type { LLMProvider } from '../llm/types';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Column {
  index: number;
  name: string;
  format: string;
  prompt: string;
  tags?: string[];
}

export interface TabularExtractInput {
  textContent: string;
  filename: string;
  columns: Column[];
}

export interface TabularEnumerateInput {
  textContent: string;
  filename: string;
  columns: Column[];
  /** What ONE row is, as a noun phrase: "condition precedent", "reporting
   *  covenant". The whole tool turns on this: the columns say what to record
   *  about a row, and only this says what counts as a row at all. */
  rowDefinition: string;
}

// ── handleTabularExtract ────────────────────────────────────────────────────────

export async function handleTabularExtract(
  input: TabularExtractInput,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  if (!input.textContent || !input.columns?.length) {
    return { success: false, error: 'tabular_extract requires "textContent" and "columns"' };
  }

  // Process columns in parallel, max 5 at a time
  const CONCURRENCY = 5;
  const results: string[] = new Array(input.columns.length).fill('');

  for (let i = 0; i < input.columns.length; i += CONCURRENCY) {
    const batch = input.columns.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(column => extractColumn(column, input.textContent, ctx)),
    );
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return {
    success: true,
    result: { row: results },
  };
}

// ── handleTabularEnumerate ──────────────────────────────────────────────────────

/** How many rows one document may yield. A runaway model asked to enumerate
 *  every obligation in a 300-page facility agreement will keep going until the
 *  token budget stops it, and a table nobody can read is not a better answer
 *  than a truncated one that says it was truncated. */
const MAX_ROWS = 200;

export async function handleTabularEnumerate(
  input: TabularEnumerateInput,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  if (!input.textContent || !input.columns?.length || !input.rowDefinition) {
    return {
      success: false,
      error: 'tabular_enumerate requires "textContent", "columns" and "rowDefinition"',
    };
  }

  const columns = [...input.columns].sort((a, b) => a.index - b.index);
  const columnSpec = columns
    .map(c => `- "${c.name}" (${c.format}): ${c.prompt}${tagList(c)}`)
    .join('\n');

  const prompt =
    `${input.textContent}\n\n---\n\n` +
    `Find every ${input.rowDefinition} in the document above. ` +
    `Produce one row for each one, in the order they appear.\n\n` +
    `Each row has exactly these fields:\n${columnSpec}\n\n` +
    `Return a JSON array of objects and nothing else: no prose before or after, ` +
    `no markdown fence. Each object has exactly the field names listed above. ` +
    `Where a field is not stated for that row, use "Not specified". ` +
    `If the document contains no ${input.rowDefinition} at all, return [].`;

  let raw: string;
  try {
    const taskConfig = await getEntitlementsClient().getModelForTask(
      ctx.tenantId,
      'tabular_extract',
    );
    const response = await llmClient.complete(
      {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 8192,
      },
      llmClient.modelSelectionFor(taskConfig),
      {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        // The run this call belongs to. It is what ties the usage row to the
        // invocation the ledger settles — and, since BYO provider keys landed,
        // what lets the funding question be asked at all: a call with no run to
        // settle against cannot be zero-rated safely, so it stays on the managed
        // pool. Both tabular purposes are the customer's own work.
        ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
        purpose: 'tabular_enumerate',
      },
    );
    raw = response.content;
  } catch (err) {
    logger.warn(
      { err, tenantId: ctx.tenantId, filename: input.filename },
      'tabular_enumerate LLM call failed',
    );
    return { success: false, error: 'tabular_enumerate could not read the document' };
  }

  const parsed = parseRowArray(raw);
  if (!parsed) {
    logger.warn(
      { tenantId: ctx.tenantId, filename: input.filename, sample: raw.slice(0, 200) },
      'tabular_enumerate returned no parseable array',
    );
    return {
      success: false,
      error: 'tabular_enumerate did not return a JSON array of rows',
    };
  }

  // Every row carries every column, in column order, whether or not the model
  // returned that key — a caller writing this into a table needs a rectangle.
  // Cells go through the same formatValue as the single-row extractor, so a
  // date reads the same way whichever tool produced it.
  const truncated = parsed.length > MAX_ROWS;
  const rows = parsed.slice(0, MAX_ROWS).map(obj =>
    columns.map(column => formatValue(String(obj[column.name] ?? '').trim(), column)),
  );

  return {
    success: true,
    result: {
      filename: input.filename,
      columns: columns.map(c => c.name),
      rows,
      rowCount: rows.length,
      ...(truncated ? { truncated: true, truncatedAt: MAX_ROWS } : {}),
    },
  };
}

function tagList(column: Column): string {
  return column.tags?.length
    ? ` Use exactly one of: ${column.tags.map(t => `"${t}"`).join(', ')}.`
    : '';
}

/** The array out of a model response, tolerating the two things models add
 *  around JSON they were told not to add: a markdown fence, and a sentence. */
function parseRowArray(raw: string): Record<string, unknown>[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw, raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)];

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (Array.isArray(value)) {
        return value.filter(
          (row): row is Record<string, unknown> =>
            typeof row === 'object' && row !== null && !Array.isArray(row),
        );
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function formatPromptSuffix(format: string, tags?: string[]): string {
  switch (format) {
    case 'yes_no':
      return '\n\nRespond with "Yes" or "No" only. Do not include any other text.';
    case 'date':
      return '\n\nReturn the date in DD Month YYYY format (e.g. "15 January 2024"). If not stated, return "Not specified".';
    case 'monetary_amount':
      return '\n\nReturn the amount with currency symbol and commas (e.g. "USD 5,000,000" or "£250,000"). If not stated, return "Not specified".';
    case 'bulleted_list':
      return '\n\nReturn each item on its own line starting with "• ". If nothing applies, return "Not specified".';
    case 'percentage':
      return '\n\nReturn as a percentage (e.g. "8%" or "2.5%"). If not stated, return "Not specified".';
    case 'tag':
      return tags?.length
        ? `\n\nReturn exactly one of the following values: ${tags.map(t => `"${t}"`).join(', ')}. Do not return any other value.`
        : '';
    case 'number':
      return '\n\nReturn a plain number (e.g. "5" or "12.5"). If not stated, return "Not specified".';
    default:
      return '\n\nBe concise. If the information is not present in the document, return "Not specified".';
  }
}

async function extractColumn(
  column: Column,
  textContent: string,
  ctx: StandardToolContext,
): Promise<string> {
  const suffix = formatPromptSuffix(column.format, column.tags);
  const prompt = `${textContent}\n\n---\n\nExtract the following field:\n\n${column.prompt}${suffix}`;

  try {
    const taskConfig = await getEntitlementsClient().getModelForTask(ctx.tenantId, 'tabular_extract');
    const response = await llmClient.complete(
      {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
      },
      llmClient.modelSelectionFor(taskConfig),
      {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
        purpose: 'tabular_extract',
      },
    );

    const raw = response.content.trim();
    return formatValue(raw, column);
  } catch (err) {
    logger.warn(
      { err, columnName: column.name, tenantId: ctx.tenantId },
      'tabular_extract column LLM call failed',
    );
    return 'Error';
  }
}

function formatValue(raw: string, column: Column): string {
  switch (column.format) {
    case 'text':
      return raw;

    case 'bulleted_list': {
      const lines = raw
        .split('\n')
        .map(l => l.replace(/^[\s\-*•]+/, '').trim())
        .filter(Boolean);
      return lines.map(l => `\n• ${l}`).join('').replace(/^\n/, '');
    }

    case 'date': {
      // Extract ISO 8601 date or return "Not specified"
      const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/);
      if (isoMatch) return isoMatch[0];
      // Try common date patterns
      const dateMatch = raw.match(
        /(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\w+ \d{1,2},? \d{4}|\d{1,2} \w+ \d{4})/,
      );
      return dateMatch ? dateMatch[0] : 'Not specified';
    }

    case 'yes_no': {
      const lower = raw.toLowerCase();
      if (/\byes\b/.test(lower)) return 'Yes';
      if (/\bno\b/.test(lower)) return 'No';
      // Try to extract a reason from the response
      const reason = raw.slice(0, 120).replace(/\n/g, ' ');
      return `Uncertain — ${reason}`;
    }

    case 'monetary_amount': {
      const match = raw.match(/(USD|EUR|GBP|AUD|CAD|[$€£¥])\s*([\d,]+(?:\.\d{2})?)/i);
      if (match) {
        const currency = match[1].replace('$', 'USD').replace('€', 'EUR').replace('£', 'GBP');
        return `${currency} ${match[2]}`;
      }
      // Try bare number with surrounding context
      const numMatch = raw.match(/([\d,]+(?:\.\d{2})?)/);
      return numMatch ? numMatch[1] : raw.trim().slice(0, 50);
    }

    case 'percentage': {
      const match = raw.match(/([\d.]+)\s*%/);
      if (match) return `${match[1]}%`;
      const numMatch = raw.match(/([\d.]+)/);
      return numMatch ? `${numMatch[1]}%` : raw.trim().slice(0, 30);
    }

    case 'tag': {
      if (!column.tags?.length) return raw.trim();
      const lower = raw.toLowerCase();
      for (const tag of column.tags) {
        if (lower.includes(tag.toLowerCase())) return tag;
      }
      return 'Not applicable';
    }

    case 'number': {
      const match = raw.match(/([\d,]+(?:\.\d+)?)/);
      return match ? match[1].replace(/,/g, '') : raw.trim().slice(0, 30);
    }

    default:
      return raw;
  }
}
