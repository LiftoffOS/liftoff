// Insights Intro Service — Phase 7.5
//
// LLM-generated "insight intro text" — the one-paragraph summary that
// renders ABOVE the four metric cards on the dashboard. Mirrors the
// observation-service flow exactly, just with a different prompt and
// a single string output instead of an array of blocks.
//
// Why an LLM call instead of a hardcoded template:
//   - The intro is the first thing a user reads on the page. A static
//     template ("Your workforce completed N tasks for $X — led by A and B")
//     reads identically week-to-week and wastes the prime real estate.
//   - The LLM can pick a different angle each time depending on what
//     actually stands out: a cost spike, a new top performer, a streak,
//     an off-week, an emerging risk, etc. That's the whole point of an
//     "insights" section.
//
// Hybrid loading: same as observations. Phase A (the report-service) is
// pure data and loads instantly. Phase B (this service) layers an LLM
// call on top via SSE. If anything fails the section just doesn't
// render — the report itself is unaffected.
//
// Failure modes ALL return null (graceful degradation):
//   - generateReport throws        → null
//   - No meaningful data           → null
//   - LLM provider error           → null
//   - Malformed JSON               → null
//   - Empty intro string           → null

import { log } from '../infrastructure/logging';
import { llmClient } from '../llm';
import type { JSONSchema } from '../llm/types';
import { generateReport } from './report-service';
import type {
  BarChartBlock,
  MetricCardBlock,
  TableBlock,
  TextBlock,
  TimeRangeInput,
  TrendChartBlock,
  VisualizationBlock,
} from './shared-types';

const MAX_INTRO_CHARS = 280;
const MAX_OUTPUT_TOKENS = 250;

const INTRO_SYSTEM_PROMPT = `You write the one-paragraph summary that opens a workforce analytics dashboard. The reader is an operator (founder, ops lead, manager) who's about to scan a page of metric cards and charts about how their agents, people, and external agents performed this period.

Your job: write ONE short paragraph (1-3 sentences, under 280 characters total) that frames what they're about to see. The intro is the FIRST thing on the page, above the metric cards.

Rules for what makes a great intro:
1. LEAD WITH WHAT'S MOST INTERESTING. Don't open with totals every single time. Look at the data and pick the angle that actually stands out — a cost spike, a streak, a new top performer, a regression, an anomaly, a productivity milestone, an off-week, an unusually balanced workload, anything notable. If nothing is notable, then a clean totals summary is fine — but only as a fallback.
2. BE SPECIFIC. Reference real names and real numbers from the data. "Salesforce Sync drove 64% of completed work this week" beats "your AI workforce was busy." Numbers without context are wasted; phrase them as comparisons or rates wherever possible.
3. VARY THE OPENING. Avoid starting with "Here's your workforce overview" or "Your workforce completed N tasks." Use openings like:
   - "Salesforce Sync owned the week, handling 423 of your 920 tasks…"
   - "Costs ticked down 7% even as task volume rose — your AI throughput is improving…"
   - "Quiet stretch this period: 312 tasks at $1,840, with most activity concentrated on Tuesday and Thursday…"
   - "Inbox Triage joined the lineup this period and is already pulling 18% of all completed work…"
   - "Three of four agents held steady; only Customer Support dipped below its weekly baseline…"
4. BE HONEST. Don't sugar-coat. If costs went up or success rates dropped, say so directly — operators trust the dashboard more when it tells them the bad news first.
5. NO MARKDOWN, NO LISTS, NO HEADERS. Just the paragraph. Plain prose.
6. NO QUESTION MARKS, NO IMPERATIVES. Don't ask the user questions or tell them what to do. State what's true about their data. (Recommendations and "things to investigate" live in the Key Observations section at the bottom of the page — keep this purely descriptive.)
7. UNDER 280 CHARACTERS. Hard cap. Count includes spaces. If you can say it in one sentence, do.

Respond with ONLY a JSON object matching the schema. No markdown, no preamble, no backticks.`;

const INTRO_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    intro: {
      type: 'string',
      description:
        'A single paragraph (1-3 sentences, under 280 characters) opening the dashboard. Plain prose, no markdown, no headers, no lists.',
    },
  },
  required: ['intro'],
};

/**
 * Main entry point. Wraps the whole flow (report + LLM + parse + validate)
 * in a try/catch so any failure degrades gracefully to null.
 */
export async function generateInsightsIntro(
  tenantId: string,
  timeRangeInput: TimeRangeInput,
): Promise<string | null> {
  try {
    const blocks = await generateReport(tenantId, timeRangeInput);

    // If the report has nothing substantive (empty tenant, all-zero state),
    // skip the LLM call — the intro would be vacuous.
    if (!hasMeaningfulData(blocks)) {
      return null;
    }

    const summary = summarizeBlocksForPrompt(blocks);
    if (!summary.trim()) return null;

    const periodLabel = formatPeriodLabel(timeRangeInput);

    const response = await llmClient.complete(
      {
        messages: [
          // The rubric is constant; the period and the report summary are not,
          // and they are already where they belong — in the user turn, after
          // the mark. Nothing volatile sits ahead of the cached block.
          { role: 'system', content: INTRO_SYSTEM_PROMPT, cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            content: `Period: ${periodLabel}\n\nData:\n${summary}\n\nWrite the one-paragraph intro.`,
          },
        ],
        responseSchema: {
          name: 'insights_intro',
          schema: INTRO_SCHEMA,
        },
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      undefined,
      { tenantId, purpose: 'insights_intro' },
    );

    return safeParseIntroResponse(response.content);
  } catch (err) {
    log.warn(
      { tenantId, error: (err as Error).message },
      'Failed to generate insights intro — returning null',
    );
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Same meaningful-data check as observation-service. */
function hasMeaningfulData(blocks: VisualizationBlock[]): boolean {
  for (const block of blocks) {
    if (
      block.type === 'bar_chart' ||
      block.type === 'trend_chart' ||
      block.type === 'table'
    ) {
      if (hasData(block)) return true;
    }
  }
  return false;
}

function hasData(block: BarChartBlock | TrendChartBlock | TableBlock): boolean {
  if (block.type === 'table') {
    return block.rows.length > 0 || (block.groups?.length ?? 0) > 0;
  }
  return block.data.length > 0;
}

/**
 * Compact text representation of the report's blocks for the LLM prompt.
 * Identical to observation-service's helper — kept duplicated rather than
 * shared so each service can evolve its prompt independently.
 */
function summarizeBlocksForPrompt(blocks: VisualizationBlock[]): string {
  const sections: string[] = [];

  const metricCards = blocks.filter((b): b is MetricCardBlock => b.type === 'metric_card');
  if (metricCards.length > 0) {
    const lines = metricCards.map(m =>
      m.trendText ? `  - ${m.label}: ${m.value} (${m.trendText})` : `  - ${m.label}: ${m.value}`,
    );
    sections.push(`## Headline metrics\n${lines.join('\n')}`);
  }

  for (const block of blocks) {
    if (block.type === 'bar_chart') {
      if (block.data.length === 0) continue;
      const lines = block.data
        .slice(0, 15)
        .map(d => `  - ${d.label}: ${d.value}${block.valueSuffix ? ` ${block.valueSuffix}` : ''}`);
      sections.push(`## ${block.title}\n${lines.join('\n')}`);
      continue;
    }

    if (block.type === 'trend_chart') {
      if (block.data.length === 0) continue;
      const lines = block.data
        .slice(0, 15)
        .map(d => `  - ${d.label}: ${d.value}`);
      sections.push(`## ${block.title} (trend)\n${lines.join('\n')}`);
      continue;
    }

    if (block.type === 'table') {
      if (block.rows.length === 0 && (block.groups?.length ?? 0) === 0) continue;
      const columnKeys = block.columns.map(c => c.key);
      const columnLabels = block.columns.map(c => c.label).join(' | ');
      const groupLines: string[] = [];
      if (block.groups && block.groups.length > 0) {
        for (const group of block.groups.slice(0, 15)) {
          groupLines.push(
            columnKeys.map(k => String(group.summary[k] ?? '')).join(' | '),
          );
        }
      }
      const rowLines = block.rows
        .slice(0, 15)
        .map(row => columnKeys.map(k => String(row[k] ?? '')).join(' | '));
      const allRows = [...groupLines, ...rowLines].join('\n');
      sections.push(`## ${block.title}\n${columnLabels}\n${allRows}`);
      continue;
    }

    if (block.type === 'text') {
      const text = (block as TextBlock).content?.trim();
      if (text) sections.push(`## Note\n${text}`);
      continue;
    }
  }

  return sections.join('\n\n');
}

/**
 * Translate a TimeRangeInput into a human-readable label for the prompt
 * so the LLM can phrase the intro with correct period framing ("this week"
 * vs "last quarter" vs a custom date range).
 */
function formatPeriodLabel(input: TimeRangeInput): string {
  if (input.preset) {
    // Convert "this_week" → "this week"
    return input.preset.replace(/_/g, ' ');
  }
  if (input.start && input.end) {
    return `${input.start.slice(0, 10)} to ${input.end.slice(0, 10)}`;
  }
  return 'this period';
}

/**
 * Parse the LLM's JSON output and return the trimmed intro string. Returns
 * null if the response is malformed, missing the intro field, or empty
 * after trimming. Long strings are truncated to MAX_INTRO_CHARS as a hard
 * defense against the LLM ignoring the prompt's character limit.
 */
function safeParseIntroResponse(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const intro = (parsed as { intro?: unknown }).intro;
  if (typeof intro !== 'string') return null;

  const trimmed = intro.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_INTRO_CHARS) {
    // Truncate at a word boundary if possible, then add an ellipsis
    const slice = trimmed.slice(0, MAX_INTRO_CHARS);
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > MAX_INTRO_CHARS - 40 ? slice.slice(0, lastSpace) : slice) + '…';
  }

  return trimmed;
}

// ── Internal exports for tests ──────────────────────────────────────────

export const _test = {
  hasMeaningfulData,
  summarizeBlocksForPrompt,
  safeParseIntroResponse,
  formatPeriodLabel,
};
