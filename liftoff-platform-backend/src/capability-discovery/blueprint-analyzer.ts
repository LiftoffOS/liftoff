// Capability discovery — the blueprint analyzer.
//
// Deepens knowledge about ADOPTED external building blocks — refs the scorer
// surfaced in a real query — never a catalog sweep. The evidence ladder per
// ref: metadata always (the source's own record), then 'probe' once a real
// run has returned results and probe-runner.ts has re-grounded the procedure's
// output contract in that run's field shape, fanning the upgrade out to
// consuming agents. A 'source' level
// (repo analysis) is reserved in the schema for automations whose value
// probes cannot observe; the probe tier supersedes it for output grounding,
// and cloning third-party repos is its own security surface, taken on only
// if a real need shows. Output is OUR authored procedure, schema-constrained,
// stored in capability_blueprints where the scorer and the distill prior-art
// section read it back.
//
// External text is screened through the injection-detection gate BEFORE any
// model reads it: a store listing is third-party authored content on its way
// into the prompt of the system that writes agents' permanent instructions.

import { llmClient } from '../llm/client';
import { log } from '../infrastructure/logging';
// RLS_RAW_POOL_OK: capability_blueprints is platform-scoped with no RLS policy.
import { pool } from '../infrastructure/database';
import { enforcePromptInput } from '@liftoffos/injection-detector';

const ANALYZER_SYSTEM_PROMPT = `You turn one external automation's listing into a short, neutral procedure our own workforce can follow with our own tools. Write ONLY from the material provided; never invent capabilities it does not describe.

Return:
- procedureMd: at most 25 lines of markdown. What the automation takes in, the stages it performs, what it returns, and the edge cases the listing names. Neutral voice, no vendor marketing, no vendor name.
- replicable: false when the automation's value is a proprietary data source or credentialed access that a procedure cannot reproduce; true when the procedure itself is the value.`;

interface AnalyzeInput {
  source: string;
  sourceRef: string;
  title: string;
  description: string;
}

/** Per-process dedupe: one analysis per ref per process lifetime. The upsert
 *  also guards, but not paying the model twice matters more. The value is the
 *  analysis itself, so a caller that needs the row (the elevation a real run
 *  triggers, which can land before the compile has) awaits the one in flight
 *  instead of finding nothing to raise. */
const analyses = new Map<string, Promise<void>>();

async function fetchStoreMetadata(sourceRef: string): Promise<{ title: string; description: string } | null> {
  try {
    const name = sourceRef.split('/')[1];
    if (!name) return null;
    const resp = await fetch(
      `https://api.apify.com/v2/store?search=${encodeURIComponent(name)}&limit=10`,
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: { items?: Array<{ name?: string; username?: string; title?: string; description?: string }> };
    };
    const hit = body.data?.items?.find((i) => `${i.username}/${i.name}` === sourceRef);
    return hit ? { title: hit.title ?? sourceRef, description: hit.description ?? '' } : null;
  } catch {
    return null;
  }
}

export function analyzeAdoptedRef(input: AnalyzeInput): Promise<void> {
  const key = `${input.source}:${input.sourceRef}`;
  const pending = analyses.get(key);
  if (pending) return pending;
  const analysis = compileBlueprint(input);
  analyses.set(key, analysis);
  return analysis;
}

/**
 * The row a real run's observation is written onto. The compile is detached
 * from the discovery query that adopted the ref, and the customer's run that
 * discovery led to can finish first; this waits for the compile in flight, or
 * starts one from the live listing when this process never adopted the ref
 * (a run started by another instance's discovery). Returns once a row exists
 * or nothing could be compiled; the caller re-reads the row.
 */
export async function ensureBlueprintCompiled(source: string, sourceRef: string): Promise<void> {
  const pending = analyses.get(`${source}:${sourceRef}`);
  if (pending) return pending;
  const existing = await pool.query(
    `SELECT 1 FROM capability_blueprints WHERE source = $1 AND source_ref = $2 AND dead = false`,
    [source, sourceRef],
  );
  if ((existing.rowCount ?? 0) > 0) return;
  return analyzeAdoptedRef({ source, sourceRef, title: sourceRef, description: '' });
}

async function compileBlueprint(input: AnalyzeInput): Promise<void> {
  // Only external automations carry knowledge worth compiling: our own
  // registry and native tools are already documented at the source.
  if (input.source !== 'apify_store') return;

  try {
    const existing = await pool.query<{ evidence_level: string }>(
      `SELECT evidence_level FROM capability_blueprints WHERE source = $1 AND source_ref = $2 AND dead = false`,
      [input.source, input.sourceRef],
    );
    // The ladder only climbs: metadata never overwrites source or probe.
    if (existing.rows[0] && existing.rows[0].evidence_level !== 'metadata') return;

    const live = await fetchStoreMetadata(input.sourceRef);
    const title = live?.title ?? input.title;
    const description = live?.description ?? input.description;
    if (!description.trim()) {
      // Nothing to write from: a procedure compiled from a bare ref would be
      // invention, and the listing can be fetched again on the next adoption.
      log.info({ sourceRef: input.sourceRef }, 'blueprint analyzer: no listing text available; not compiled');
      analyses.delete(`${input.source}:${input.sourceRef}`);
      return;
    }

    // The detector is called DIRECTLY, not through the tenant-gated
    // screenPersistedContent wrapper: platform-scoped work has no tenant, the
    // wrapper resolves its mode from per-tenant flags (failing safe to OFF on
    // a bad tenant id), and screening third-party text on its way toward the
    // distill prompt must never be silently off. Unconditional, always
    // blocking on a block verdict.
    const screen = enforcePromptInput(`${title}\n${description}`, {
      source: 'capability-blueprint-analyzer',
    });
    if (screen.verdict === 'block') {
      log.warn({ sourceRef: input.sourceRef }, 'blueprint analyzer: listing failed injection screen; skipping');
      return;
    }

    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
          { role: 'user', content: `LISTING\nTitle: ${title}\nDescription: ${description.slice(0, 3000)}` },
        ],
        temperature: 0.2,
        responseSchema: {
          name: 'compile_blueprint',
          schema: {
            type: 'object',
            properties: {
              procedureMd: { type: 'string' },
              replicable: { type: 'boolean' },
            },
            required: ['procedureMd', 'replicable'],
          },
        },
      },
      undefined,
      { purpose: 'capability_blueprint_analyzer' },
    );
    const parsed = JSON.parse(response.content) as { procedureMd?: string; replicable?: boolean };
    if (!parsed.procedureMd) return;

    // Probe tier: only with a platform vendor credential, which is a launch
    // prerequisite owned by the operator. Absent credential = metadata level.
    const evidenceLevel = 'metadata';

    await pool.query(
      `INSERT INTO capability_blueprints
         (source, source_ref, procedure_md, evidence_level, replicable)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, source_ref) DO UPDATE
         SET procedure_md = EXCLUDED.procedure_md,
             replicable = EXCLUDED.replicable,
             last_verified_at = now(),
             updated_at = now()
       WHERE capability_blueprints.evidence_level = 'metadata'`,
      [input.source, input.sourceRef, parsed.procedureMd.slice(0, 8000), evidenceLevel, parsed.replicable === true],
    );
    log.info(
      { metric: 'capability_blueprint.compiled', sourceRef: input.sourceRef, replicable: parsed.replicable === true },
      'blueprint compiled',
    );

    // The ladder's next rung — 'probe' — is climbed by probe-runner.ts when a
    // real run of this automation returns results; nothing is launched here.
  } catch (error) {
    log.warn({ error, sourceRef: input.sourceRef }, 'blueprint analysis failed');
  }
}
