// Capability discovery — the probe tier and the upgrade loop.
//
// A blueprint starts at 'metadata': a procedure our analyzer wrote from the
// automation's store listing alone. It rises to 'probe' once the platform has
// seen the automation's REAL output, and the procedure's output contract is
// rewritten against what a run actually returns.
//
// The observation comes from a real run — a customer's request that ran the
// automation and got results — not from a test run of our own. Launching a
// run of every newly adopted automation with the vendor's example input, on
// the platform account, at the platform's cost, is a poor sample: such runs
// often return nothing (the example input of a subreddit scraper names no
// subreddit), an empty result would still be written up as evidence, and the
// extra run of the same actor races the customer's run for the cost read. A
// real run is the better sample and costs nothing extra; an
// automation that is surfaced but never run stays at 'metadata', which is the
// truth.
//
// SHAPE, NEVER VALUES. The procedure is platform-wide — every workspace's
// distillation reads it — while the run's items are one customer's results.
// So the refine step is shown the field names and JSON types the items carry,
// with how many of the observed items carry each, and no string, number or
// nested value from the items themselves. describeOutputShape is the only
// path from items to prompt and the unit test pins that no item value reaches
// the model.
//
// The RISE is what the upgrade loop keys on: agents whose distillations were
// authored against the shallower knowledge (capability_distill_consumption)
// get a platform redistill — permitted without user consent, never touching
// lifecycle state — so their instructions catch up with what the platform
// now knows. Fan-out is bounded per elevation; later elevations page.

import { llmClient } from '../llm/client';
import { log } from '../infrastructure/logging';
// RLS_RAW_POOL_OK: capability_blueprints is platform-scoped with no RLS policy.
import { pool } from '../infrastructure/database';
import { getConsumersOfRef } from './evidence';
import { ensureBlueprintCompiled } from './blueprint-analyzer';

/** Items examined for the shape. More items refine "present in k of N"; the
 *  field set of a scraper's records is stable well before this. */
const SHAPE_SAMPLE_ITEMS = 5;
/** Fields listed for the model. A record wider than this is a dump, not a
 *  contract, and the tail is counted rather than listed. */
const MAX_SHAPE_FIELDS = 60;
/** Redistills triggered per elevation; consumers beyond this catch up on a
 *  later elevation or their next ordinary redistill. */
const UPGRADE_FANOUT_LIMIT = 20;

const REFINE_SYSTEM_PROMPT = `You refine a procedure for reproducing an external automation, now that the shape of a real run's output is known. Keep the procedure at most 25 lines of markdown, neutral voice, no vendor marketing, no vendor name. Rewrite the OUTPUT CONTRACT part from the observed field names and types; change nothing the observation does not justify. You are shown field names and types only, never values: do not invent example values.`;

export interface ObservedField {
  /** Dotted path, one level deep for objects and arrays of objects. */
  path: string;
  /** JSON types seen at this path, sorted. */
  types: string[];
  /** How many of the examined items carry the path. */
  presentIn: number;
}

export interface OutputShape {
  itemsExamined: number;
  fields: ObservedField[];
  /** Fields beyond MAX_SHAPE_FIELDS, counted rather than listed. */
  omittedFields: number;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** The field names and types of a run's items — nothing else. Objects and
 *  arrays of objects contribute their keys one level down; anything deeper is
 *  reported by its type only. */
export function describeOutputShape(items: readonly unknown[]): OutputShape {
  const examined = items.slice(0, SHAPE_SAMPLE_ITEMS);
  const seen = new Map<string, { types: Set<string>; presentIn: number }>();
  const note = (path: string, value: unknown) => {
    const entry = seen.get(path) ?? { types: new Set<string>(), presentIn: 0 };
    entry.types.add(jsonType(value));
    entry.presentIn += 1;
    seen.set(path, entry);
  };
  for (const item of examined) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      note('$', item);
      continue;
    }
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      note(key, value);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
          note(`${key}.${subKey}`, subValue);
        }
      } else if (Array.isArray(value)) {
        const first = value.find((v) => v && typeof v === 'object' && !Array.isArray(v));
        if (first) {
          for (const [subKey, subValue] of Object.entries(first as Record<string, unknown>)) {
            note(`${key}[].${subKey}`, subValue);
          }
        }
      }
    }
  }
  const fields = [...seen.entries()].map(([path, entry]) => ({
    path,
    types: [...entry.types].sort(),
    presentIn: entry.presentIn,
  }));
  return {
    itemsExamined: examined.length,
    fields: fields.slice(0, MAX_SHAPE_FIELDS),
    omittedFields: Math.max(0, fields.length - MAX_SHAPE_FIELDS),
  };
}

/** The prompt block: one line per field, no values anywhere. */
export function renderOutputShape(shape: OutputShape): string {
  const lines = shape.fields.map(
    (f) => `- ${f.path}: ${f.types.join(' | ')} (present in ${f.presentIn} of ${shape.itemsExamined})`,
  );
  if (shape.omittedFields > 0) lines.push(`- … and ${shape.omittedFields} more fields not listed`);
  return `OBSERVED OUTPUT SHAPE (${shape.itemsExamined} items examined)\n${lines.join('\n')}`;
}

/** One elevation per ref per process lifetime; the DB evidence_level guard
 *  makes cross-process duplicates harmless (a second elevation of a probe-level
 *  row is refused by the WHERE below). */
const elevated = new Set<string>();

/**
 * Raise a blueprint to probe evidence from a real run that returned results.
 * Called by the executor after a successful platform-funded run, detached from
 * the tool result. Never throws.
 *
 * An empty run teaches nothing and changes nothing: the caller does not call
 * this for zero items, and the guard here is the second line.
 */
export async function elevateBlueprintFromRun(input: {
  source: string;
  sourceRef: string;
  items: readonly unknown[];
  runId: string;
}): Promise<void> {
  if (input.source !== 'apify_store') return;
  if (input.items.length === 0) {
    log.info(
      { metric: 'capability_probe.inconclusive', sourceRef: input.sourceRef, runId: input.runId },
      'run returned no items; blueprint unchanged',
    );
    return;
  }

  const key = `${input.source}:${input.sourceRef}`;
  if (elevated.has(key)) return;
  elevated.add(key);

  try {
    // The first real run can finish before the listing has been compiled (the
    // compile is detached from the discovery query that adopted the ref), so
    // wait for the row this UPDATE needs rather than lose the observation.
    await ensureBlueprintCompiled(input.source, input.sourceRef);
    const current = await pool.query<{ procedure_md: string }>(
      `SELECT procedure_md FROM capability_blueprints
        WHERE source = $1 AND source_ref = $2 AND evidence_level = 'metadata' AND dead = false`,
      [input.source, input.sourceRef],
    );
    const procedureMd = current.rows[0]?.procedure_md;
    if (!procedureMd) return; // no metadata-level row to raise: never compiled, or already elevated

    const shape = describeOutputShape(input.items);
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: REFINE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `CURRENT PROCEDURE\n${procedureMd.slice(0, 4000)}\n\n${renderOutputShape(shape)}`,
          },
        ],
        temperature: 0.2,
        responseSchema: {
          name: 'refine_blueprint',
          schema: {
            type: 'object',
            properties: { procedureMd: { type: 'string' } },
            required: ['procedureMd'],
          },
        },
      },
      undefined,
      { purpose: 'capability_blueprint_analyzer' },
    );
    const refined = (JSON.parse(response.content) as { procedureMd?: string }).procedureMd;

    const updated = await pool.query(
      `UPDATE capability_blueprints
          SET evidence_level = 'probe',
              procedure_md = COALESCE(NULLIF($3, ''), procedure_md),
              golden_output_ref = $4,
              last_verified_at = now(),
              updated_at = now()
        WHERE source = $1 AND source_ref = $2 AND evidence_level = 'metadata'
        RETURNING id`,
      [input.source, input.sourceRef, (refined ?? '').slice(0, 8000), `apify:run:${input.runId}`],
    );
    if (updated.rows.length === 0) return; // already elevated elsewhere

    log.info(
      {
        metric: 'capability_probe.elevated',
        sourceRef: input.sourceRef,
        runId: input.runId,
        itemsExamined: shape.itemsExamined,
        fields: shape.fields.length,
      },
      'blueprint elevated to probe evidence from a real run',
    );
    await fanOutUpgrade(input.source, input.sourceRef);
  } catch (error) {
    log.warn({ error, sourceRef: input.sourceRef }, 'blueprint elevation errored; blueprint unchanged');
  }
}

/** Platform redistills for the agents authored against the pre-probe
 *  knowledge. Sequential and bounded — an elevation must never stampede the
 *  distillation service. Lazily imported: redistill-service reaches
 *  distill-service, which consumes this package, and a static import would
 *  close that cycle. */
async function fanOutUpgrade(source: string, sourceRef: string): Promise<void> {
  const consumers = await getConsumersOfRef(source, sourceRef, UPGRADE_FANOUT_LIMIT);
  if (consumers.length === 0) return;
  const { redistillAgent } = await import('../internal-agents/redistill-service');
  let refreshed = 0;
  for (const { tenantId, agentId } of consumers) {
    try {
      await redistillAgent(agentId, tenantId, undefined);
      refreshed += 1;
    } catch (error) {
      log.warn({ error, agentId, tenantId, sourceRef }, 'upgrade redistill failed; continuing');
    }
  }
  log.info(
    { metric: 'capability_probe.upgrade_fanout', sourceRef, consumers: consumers.length, refreshed },
    'upgrade redistills complete',
  );
}
