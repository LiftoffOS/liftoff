// Insights Observation Service — Phase 7
//
// Phase B of the hybrid loading strategy: the dashboard report loads
// instantly via GET /api/insights/report (Phase 2, pure data, no LLM),
// and the "Key Observations" section is populated separately here by
// calling an LLM over the same aggregated data.
//
// Flow:
//   1. Call generateReport() to get the same VisualizationBlock[] the
//      frontend sees in Phase A
//   2. Summarize those blocks into a compact text representation
//   3. Ask the LLM to extract 3-5 observations as structured JSON via
//      responseSchema (no streaming, no tool calls — single shot)
//   4. Validate each observation's shape and icon, drop anything
//      malformed, return a clean ObservationBlock[]
//
// Failure modes ALL return an empty array (graceful degradation):
//   - generateReport throws        → []
//   - No meaningful data to observe → []
//   - LLM provider error            → []
//   - Malformed JSON                → []
//   - No valid observations in response → []
//
// The plan treats observations as an enhancement, NOT a requirement —
// if the LLM is unavailable or the tenant has no data, the frontend
// just doesn't show the section. Observations must NEVER block the
// user-facing report.

import { log } from '../infrastructure/logging';
import { llmClient } from '../llm';
import type { JSONSchema } from '../llm/types';
import { generateReport } from './report-service';
import type {
  BarChartBlock,
  MetricCardBlock,
  ObservationBlock,
  TableBlock,
  TextBlock,
  TimeRangeInput,
  TrendChartBlock,
  VisualizationBlock,
} from './shared-types';

const MAX_OBSERVATIONS = 5;
const MIN_OBSERVATIONS = 3;
const MAX_OUTPUT_TOKENS = 800;

const VALID_ICONS = new Set(['+', '!', '-', '?']);

const OBSERVATION_SYSTEM_PROMPT = `You are an analytics assistant reviewing a dashboard of workforce metrics for a company's agents, people, and external agents.

Given a summary of the current period's data, generate ${MIN_OBSERVATIONS}-${MAX_OBSERVATIONS} key observations about notable trends, anomalies, or takeaways. Each observation is ONE sentence, under 150 characters.

Assign an icon based on the nature of the observation:
- "+" for positive trends (improvements, cost savings, higher throughput, lower error rates)
- "!" for warnings (unusual spikes, potential issues, noteworthy but not-yet-concerning changes)
- "-" for concerning trends (regressions, climbing error rates, declining throughput)
- "?" for open questions or suggestions (worth investigating further, unclear root cause)

Focus on what's most useful: what's working, what's broken, what needs attention. Do NOT restate raw numbers — point out what the numbers MEAN. Reference specific agent names or metrics where relevant.

If the data shows nothing remarkable, return fewer observations — do not fabricate ones.

Respond with ONLY a JSON object matching the schema. No markdown, no preamble.`;

const OBSERVATION_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      description: 'List of 3-5 key observations derived from the report data.',
      items: {
        type: 'object',
        properties: {
          icon: {
            type: 'string',
            enum: ['+', '!', '-', '?'],
            description: 'Icon representing the nature of the observation.',
          },
          content: {
            type: 'string',
            description: 'A single-sentence observation under 150 characters.',
          },
        },
        required: ['icon', 'content'],
      },
    },
  },
  required: ['observations'],
};

/**
 * Main entry point. Wraps the whole flow (report + LLM + parse + validate)
 * in a try/catch so any failure degrades gracefully to an empty array.
 */
export async function generateInsightsObservations(
  tenantId: string,
  timeRangeInput: TimeRangeInput,
): Promise<ObservationBlock[]> {
  try {
    const blocks = await generateReport(tenantId, timeRangeInput);

    // If the report has nothing substantive (empty tenant, all-zero state),
    // skip the LLM call — the observations would be useless.
    if (!hasMeaningfulData(blocks)) {
      return [];
    }

    const summary = summarizeBlocksForPrompt(blocks);
    if (!summary.trim()) return [];

    const response = await llmClient.complete(
      {
        messages: [
          // Constant rubric ahead of a per-period summary: the prefix is the
          // same bytes on every tenant's dashboard load.
          { role: 'system', content: OBSERVATION_SYSTEM_PROMPT, cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            content: `Here is a summary of the workforce metrics for this period:\n\n${summary}\n\nGenerate ${MIN_OBSERVATIONS}-${MAX_OBSERVATIONS} key observations.`,
          },
        ],
        responseSchema: {
          name: 'insights_observations',
          schema: OBSERVATION_SCHEMA,
        },
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      undefined,
      { tenantId, purpose: 'insights_observation' },
    );

    const parsed = safeParseObservationsResponse(response.content);
    return parsed.slice(0, MAX_OBSERVATIONS);
  } catch (err) {
    log.warn(
      { tenantId, error: (err as Error).message },
      'Failed to generate insights observations — returning empty list',
    );
    return [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Does the report contain anything an observation could meaningfully speak
 * to? Metric cards alone don't count (a tenant with zero data still gets
 * the four default cards); we look for chart / table / text blocks that
 * indicate actual activity.
 */
function hasMeaningfulData(blocks: VisualizationBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'bar_chart' || block.type === 'trend_chart' || block.type === 'table') {
      // Only count blocks that actually have rows
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
 * Compact text representation of the report's blocks, suitable for stuffing
 * into the LLM prompt. We don't send the raw VisualizationBlock JSON because
 * it's verbose and contains frontend-specific fields (max, variant, etc.)
 * that don't help the LLM reason about the data.
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
      const rowLines = block.rows
        .slice(0, 15)
        .map(row => columnKeys.map(k => String(row[k] ?? '')).join(' | '));
      sections.push(`## ${block.title}\n${columnLabels}\n${rowLines.join('\n')}`);
      continue;
    }

    if (block.type === 'text') {
      const text = (block as TextBlock).content?.trim();
      if (text) sections.push(`## Note\n${text}`);
      continue;
    }
    // metric_card already handled above; observation blocks skipped (none
    // expected from generateReport, but guard anyway).
  }

  return sections.join('\n\n');
}

/**
 * Parse the LLM's JSON output and return valid ObservationBlock instances.
 * Silently drops anything that doesn't match the schema — the LLM occasionally
 * ignores the icon enum or emits extra fields.
 */
function safeParseObservationsResponse(content: string): ObservationBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const observations =
    parsed && typeof parsed === 'object'
      ? (parsed as { observations?: unknown }).observations
      : null;

  if (!Array.isArray(observations)) return [];

  const result: ObservationBlock[] = [];
  for (const item of observations) {
    if (!item || typeof item !== 'object') continue;
    const icon = (item as { icon?: unknown }).icon;
    const contentField = (item as { content?: unknown }).content;
    if (typeof icon !== 'string' || typeof contentField !== 'string') continue;
    if (!VALID_ICONS.has(icon)) continue;
    const trimmed = contentField.trim();
    if (!trimmed) continue;
    result.push({
      type: 'observation',
      icon: icon as '+' | '!' | '-' | '?',
      content: trimmed,
    });
  }
  return result;
}

// ── Internal exports for tests ──────────────────────────────────────────

export const _test = {
  hasMeaningfulData,
  summarizeBlocksForPrompt,
  safeParseObservationsResponse,
};
