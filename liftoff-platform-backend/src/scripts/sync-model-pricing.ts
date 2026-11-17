// model-pricing-sync — reconcile registry facts we can get from the vendor
// against the vendor, for every OpenRouter-hosted model we have approved. Three
// facts today: per-million RATES into `model_pricing` (migration 285), each
// model's CONTEXT WINDOW onto its `models` row (migration 342), and its INPUT
// MODALITIES onto that row's capabilities (migration 395). Run as the
// model-pricing-sync-{env} Cloud Run Job on a schedule.
//
// Modality lives here rather than in the tier loader because this job is the
// only thing in the estate that talks to OpenRouter, and it already owns
// exactly the five vendor keys whose models OpenRouter serves. One catalog
// request per run covers all of them. It reconciles in BOTH directions — a
// vendor that drops a modality has it removed — because a stale 'vision' mark
// is a 400 from the vendor on a turn that carries a picture, which is the
// failure the gate exists to prevent.
//
// Conservative rate = MAX across all serving endpoints for a model. With no
// provider allow-list, OpenRouter's default routing can land on any endpoint, so
// the max is the fail-safe-toward-business rate (over- rather than under-attribute),
// consistent with src/llm/pricing.ts. Only models REGISTERED (status='approved')
// under an OpenRouter-hosted provider are synced — we never mirror OpenRouter's
// whole catalog. A registered model with no OpenRouter match is logged LOUDLY
// (this is the check that catches a bad/non-existent slug at sync time).
//
// The window is ALSO the max across endpoints, and it is worth saying why,
// because it is the same direction as the rate for an unrelated reason and a
// later reader will otherwise "fix" one of them. Endpoints genuinely disagree —
// z-ai/glm-5.2 serves from 96,890 up to 1,048,576 — so a single number cannot be
// right for all of them, and the question is only which way to be wrong:
//
//   Overstate (max): a run that overflows the endpoint it actually landed on is
//   rejected by the provider, and the resulting error text is detected as an
//   overflow by a path that needs no window at all. We under-detect, and
//   degrade to exactly today's behaviour.
//
//   Understate (min): a healthy run on a larger endpoint reads as saturated,
//   and the runtime retires a perfectly good session on that reading. A
//   data-losing false positive produced by the check meant to prevent data loss.
//
// So: max. Under-detection is recoverable; a wrongly retired conversation is not.
import { reportPricingCoverageAtBoot } from '../llm/pricing-coverage';
import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, getPool, closePools } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { MODEL_PRICING, pricingKeysFor } from '../llm/pricing';
import { OPENROUTER_HOSTED_PROVIDERS } from '../model-registry/workspace-ai-vendors';
import type { PricingOverride } from '../llm/pricing-tiers';

// The providers whose models are hosted on OpenRouter and priced from the
// OpenRouter API. Derived from the vendor record's `transport`, so it cannot
// disagree with what those vendors actually are: written out, it named the
// gateway ('openrouter') where it meant GLM.
//
// Grok is not among them because its transport is direct: it executes on xAI's
// own API, so its rates come from xAI's price list and its rows are keyed
// 'xai:<native id>'. Syncing it from here would write rows no lookup reads.
export const OPENROUTER_PROVIDERS: readonly string[] = OPENROUTER_HOSTED_PROVIDERS;
// A rate is keyed by the provider the lookup will use, and after migration 450
// that is the same key the registry row carries — the family. It was the
// gateway's name for all four, which meant a Qwen rate synced from OpenRouter's
// own catalog was written as `openrouter:qwen/...` and read as `qwen:qwen/...`:
// present, correct, and invisible.
const MARGIN_RAW = Number(process.env.MODEL_PRICING_MARGIN ?? '1.0');
// Guard a misconfigured env (NaN / non-positive) — a bad margin must not zero out
// or NaN every rate.
const MARGIN = Number.isFinite(MARGIN_RAW) && MARGIN_RAW > 0 ? MARGIN_RAW : 1.0;
const OR_BASE = process.env.OPENROUTER_API_BASE ?? 'https://openrouter.ai/api/v1';

/** One conditional override as OpenRouter serves it: condition fields plus any
 *  subset of the rate keys, all per-token strings. */
interface OrPricingOverride {
  min_prompt_tokens?: number;
  utc_start?: number;
  utc_end?: number;
  utc_days?: string[];
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_cache_write_1h?: string;
}

/** The keys of an override entry that carry a RATE, as opposed to the ones that
 *  carry a CONDITION. Spelled once so the merge and the raise-only pass below
 *  cannot come to disagree about which is which — a condition field treated as
 *  a rate would be compared against a price. */
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;
type RateKey = (typeof RATE_KEYS)[number];

interface OrEndpoint {
  pricing: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    overrides?: OrPricingOverride[];
  };
  context_length?: number;
}

/** Conservative (max-across-endpoints) per-million rates for an OpenRouter slug,
 *  base plus any conditional overrides, or null when the slug serves no
 *  endpoints (i.e. does not exist on OpenRouter). */
export async function fetchConservativeRate(
  slug: string,
): Promise<{
  input: number;
  output: number;
  cacheRead: number | null;
  overrides: PricingOverride[] | null;
} | null> {
  const endpoints = await fetchEndpoints(slug);
  if (endpoints == null || endpoints.length === 0) return null;

  // Rounded to 6dp, the precision of the NUMERIC(12,6) columns these land in.
  // The flat rates get that rounding from Postgres on write; the override bands
  // do NOT, because they are stored as JSONB, so `0.0000001 * 1e6` persists as
  // 0.09999999999999999 rather than 0.1. The difference is ~1e-16 and changes no
  // bill, but a rate table full of float noise invites a later reader to
  // distrust figures that are in fact exact. Round once, here, so both paths
  // carry the same precision.
  const perMillion = (s: string | undefined): number | null =>
    s == null ? null : Math.round(Number(s) * 1_000_000 * 1e6) / 1e6;

  let input = 0;
  let output = 0;
  let cacheRead: number | null = null;
  for (const e of endpoints) {
    input = Math.max(input, perMillion(e.pricing.prompt) ?? 0);
    output = Math.max(output, perMillion(e.pricing.completion) ?? 0);
    const c = perMillion(e.pricing.input_cache_read);
    if (c != null) cacheRead = Math.max(cacheRead ?? 0, c);
  }
  // Never emit a $0 input/output rate — that would silently under-attribute (the
  // exact billing hole this sync exists to prevent). Treat "no usable price found"
  // as unmatched so the conservative static MODEL_PRICING fallback applies instead.
  if (!(input > 0) || !(output > 0)) return null;
  const base = {
    input: input * MARGIN,
    output: output * MARGIN,
    cacheRead: cacheRead == null ? null : cacheRead * MARGIN,
  };
  return { ...base, overrides: mergeOverrides(endpoints, perMillion, base) };
}

/** Collapse every endpoint's override array into ONE array for the model.
 *
 *  Two distinct uncertainties meet here and must not be conflated:
 *
 *    - WHICH ENDPOINT served a given request is unknowable (no provider
 *      allow-list, so OpenRouter's routing can land anywhere). That stays
 *      conservative: max across endpoints, same as the base rates above.
 *    - WHETHER A CONDITION MATCHED is knowable per row — we have the prompt
 *      size and the timestamp — so conditions are preserved verbatim and
 *      evaluated exactly at cost time rather than being flattened away.
 *
 *  So: group entries by condition signature, take the max per rate key within
 *  each group, and emit groups ordered by ascending minPromptTokens. Ascending
 *  order matters because the evaluator folds in array order with last-writer-
 *  wins: it puts the highest (most specific) threshold last, which is both the
 *  correct precedence reading and the conservative one. Do not "simplify" this
 *  to an unordered map.
 *
 *  Then the two are reconciled, which is the part that is easy to miss: a band
 *  may only RAISE the conservative base, never lower it. See the pass at the
 *  bottom. */
function mergeOverrides(
  endpoints: OrEndpoint[],
  perMillion: (s: string | undefined) => number | null,
  base: { input: number; output: number; cacheRead: number | null },
): PricingOverride[] | null {
  const byCondition = new Map<string, PricingOverride>();

  for (const e of endpoints) {
    for (const o of e.pricing.overrides ?? []) {
      // Days are normalized (lowercased, sorted) for the SIGNATURE only, so two
      // endpoints naming the same days in a different order group together;
      // the value kept below stays the vendor's own array.
      const days = [...(o.utc_days ?? [])].map((d) => d.toLowerCase()).sort().join(',');
      const key = `${o.min_prompt_tokens ?? ''}|${o.utc_start ?? ''}|${o.utc_end ?? ''}|${days}`;
      const existing = byCondition.get(key) ?? {
        ...(o.min_prompt_tokens != null ? { minPromptTokens: o.min_prompt_tokens } : {}),
        ...(o.utc_start != null ? { utcStart: o.utc_start } : {}),
        ...(o.utc_end != null ? { utcEnd: o.utc_end } : {}),
        ...(o.utc_days != null ? { utcDays: o.utc_days } : {}),
      };

      // Max per key, and only for keys this entry actually declares — an absent
      // key inherits the BASE rate at evaluation time, so materializing it here
      // as 0 would silently zero out a real charge.
      const bump = (field: RateKey, raw: string | undefined): void => {
        const v = perMillion(raw);
        if (v == null) return;
        const prev = existing[field];
        existing[field] = Math.max(prev ?? 0, v * MARGIN);
      };
      bump('input', o.prompt);
      bump('output', o.completion);
      bump('cacheRead', o.input_cache_read);
      bump('cacheWrite5m', o.input_cache_write);
      bump('cacheWrite1h', o.input_cache_write_1h);

      byCondition.set(key, existing);
    }
  }

  if (byCondition.size === 0) return null;

  // A band may only RAISE the conservative rate, never lower it.
  //
  // The base is the MAX across endpoints because routing is unknowable, but a
  // band is published by ONE endpoint and binds only that one. A band that
  // undercuts the base would price a request at the cheapest endpoint's
  // conditional rate when any endpoint could have served it. DeepSeek V4.1
  // Flash is the live case and it is not a tail case: its own endpoint
  // publishes every band, all below the cross-endpoint max, and one of them
  // carries no window at all — so without this pass the base would never be
  // reached and every row would bill at well under half the conservative rate.
  //
  // Dropping a key is not zeroing it: an absent key inherits the base at
  // evaluation time (pricing-tiers note 3), which is exactly the conservative
  // answer. An entry left with no rate key at all is dropped whole. Bands that
  // sit above base — every Qwen and Grok band — pass through untouched.
  const baseFor: Record<RateKey, number> = {
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead ?? 0,
    // These endpoints publish no Anthropic-style cache-write tier, so the base
    // is 0 and any cache-write band a vendor does publish raises it.
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };

  const raised: PricingOverride[] = [];
  for (const entry of byCondition.values()) {
    const kept: PricingOverride = {
      ...(entry.minPromptTokens != null ? { minPromptTokens: entry.minPromptTokens } : {}),
      ...(entry.utcStart != null ? { utcStart: entry.utcStart } : {}),
      ...(entry.utcEnd != null ? { utcEnd: entry.utcEnd } : {}),
      ...(entry.utcDays != null ? { utcDays: entry.utcDays } : {}),
    };
    let keptAny = false;
    for (const k of RATE_KEYS) {
      const v = entry[k];
      if (v == null || v <= baseFor[k]) continue;
      kept[k] = v;
      keptAny = true;
    }
    if (keptAny) raised.push(kept);
  }

  if (raised.length === 0) return null;
  return raised.sort((a, b) => (a.minPromptTokens ?? 0) - (b.minPromptTokens ?? 0));
}

/** The serving endpoints OpenRouter lists for a slug, or null when the request
 *  failed or the slug does not exist. Null and [] are kept distinct: one means
 *  we could not ask, the other means we asked and it serves nothing. */
async function fetchEndpoints(slug: string): Promise<OrEndpoint[] | null> {
  const res = await fetch(`${OR_BASE}/models/${slug}/endpoints`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { endpoints?: OrEndpoint[] } };
  return body.data?.endpoints ?? [];
}

/** Largest context window across a slug's serving endpoints, or null when none
 *  publishes one. See the header for why the largest rather than the smallest. */
export async function fetchContextWindow(slug: string): Promise<number | null> {
  const endpoints = await fetchEndpoints(slug);
  if (endpoints == null || endpoints.length === 0) return null;

  let window = 0;
  for (const e of endpoints) {
    const n = Number(e.context_length);
    if (Number.isInteger(n) && n > 0) window = Math.max(window, n);
  }
  return window > 0 ? window : null;
}

/** The capability strings this job reconciles, and the OpenRouter input
 *  modality that earns each one. `vision` is spelled the same way in
 *  src/llm/vision.ts, which is the only consumer that must agree. */
const MODALITY_CAPABILITIES: ReadonlyArray<{ capability: string; modality: string }> = [
  { capability: 'vision', modality: 'image' },
  { capability: 'video', modality: 'video' },
];

/** One model as the OpenRouter catalog lists it. Only the two fields this job
 *  reads are declared. */
interface OrCatalogModel {
  id?: string;
  architecture?: { input_modalities?: string[] };
}

/** Input modalities per OpenRouter slug for the WHOLE catalog, or null when the
 *  request failed.
 *
 *  Null and an empty map are kept distinct for the same reason fetchEndpoints
 *  keeps them distinct: one means we could not ask, and answering "no
 *  modalities" to that would strip every mark in the registry on a bad day.
 *  One request covers every model, so this is called once per run rather than
 *  once per model.
 *
 *  A model the catalog LISTS but publishes no modality block for maps to an
 *  empty list, not to a missing entry, so its marks are removed. That is the
 *  fail-safe direction and the same one the vision gate itself takes: an
 *  unmarked model is told in words that the picture cannot be read, while a
 *  wrongly marked one gets a 400 from the vendor. Every entry publishes a list
 *  today; this decides what happens the day one stops. */
export async function fetchInputModalities(): Promise<Map<string, string[]> | null> {
  const res = await fetch(`${OR_BASE}/models`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: OrCatalogModel[] };
  if (!Array.isArray(body.data)) return null;
  const out = new Map<string, string[]>();
  for (const m of body.data) {
    if (typeof m?.id !== 'string') continue;
    const modalities = m.architecture?.input_modalities;
    out.set(m.id, Array.isArray(modalities) ? modalities.filter((x) => typeof x === 'string') : []);
  }
  return out;
}

/** Bring one model's `vision` / `video` capabilities into line with what the
 *  vendor says it accepts. Returns the capabilities that changed.
 *
 *  Adds and removes. The add is guarded by NOT (capabilities @> ...) and the
 *  remove by (capabilities @> ...), so a row already correct is not written and
 *  `updated_at` does not churn on every run. `jsonb - text` removes a matching
 *  string element from an array and leaves every other capability in place,
 *  which is the same append-only discipline migration 395 uses. */
async function reconcileModalities(
  pool: ReturnType<typeof getPool>,
  provider: string,
  modelId: string,
  modalities: readonly string[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const { capability, modality } of MODALITY_CAPABILITIES) {
    const want = modalities.includes(modality);
    const asArray = JSON.stringify([capability]);
    const res = want
      ? await pool.query(
          `UPDATE models
              SET capabilities = capabilities || $3::jsonb,
                  updated_at   = NOW()
            WHERE provider = $1 AND model_id = $2
              AND NOT (capabilities @> $3::jsonb)`,
          [provider, modelId, asArray],
        )
      : await pool.query(
          `UPDATE models
              SET capabilities = capabilities - $3::text,
                  updated_at   = NOW()
            WHERE provider = $1 AND model_id = $2
              AND capabilities @> $4::jsonb`,
          [provider, modelId, capability, asArray],
        );
    if ((res.rowCount ?? 0) > 0) changed.push(`${want ? '+' : '-'}${capability}`);
  }
  return changed;
}

export async function main(): Promise<void> {
  await initSecrets();
  await initDatabase();
  const pool = getPool();

  const { rows } = await pool.query<{ provider: string; model_id: string }>(
    `SELECT provider, model_id FROM models
      WHERE status = 'approved' AND provider = ANY($1)`,
    [OPENROUTER_PROVIDERS],
  );

  // One catalog request for the whole run. Null means the request failed, and a
  // failed request knows nothing about modality — every row is left exactly as
  // it is rather than being stripped.
  const catalogModalities = await fetchInputModalities();
  if (catalogModalities == null) {
    log.error(
      { event: 'model_modality_catalog_unavailable' },
      'modality sync: the OpenRouter catalog could not be read — vision/video marks are left untouched this run.',
    );
  }

  let synced = 0;
  let unmatched = 0;
  let windowsSynced = 0;
  let modalitiesChanged = 0;
  for (const { provider, model_id } of rows) {
    // Modality is reconciled independently of the rate and the window, for the
    // same reason they are independent of each other: a slug can publish
    // modalities and no usable price, and the vision gate must not go stale
    // because the pricing half of the run had nothing to write.
    //
    // A model the catalog does not list at all is SKIPPED rather than stripped.
    // Absence there is the same signal the unmatched-pricing branch below logs
    // loudly, and the honest response to "the vendor has never heard of this
    // slug" is to leave the hand-recorded marks alone.
    const modalities = catalogModalities?.get(model_id);
    if (modalities) {
      const changed = await reconcileModalities(pool, provider, model_id, modalities);
      if (changed.length > 0) {
        modalitiesChanged++;
        log.info({ provider, model_id, changed, modalities }, 'model modality reconciled');
      }
    }

    // The window is synced independently of the rate: a slug can publish a
    // context length and no usable price, and losing the window because the
    // price was unusable would put the model back on a provider floor.
    const contextWindow = await fetchContextWindow(model_id);
    if (contextWindow != null) {
      await pool.query(
        `UPDATE models SET context_window = $3, updated_at = NOW()
          WHERE provider = $1 AND model_id = $2
            AND context_window IS DISTINCT FROM $3`,
        [provider, model_id, contextWindow],
      );
      windowsSynced++;
    }

    const rate = await fetchConservativeRate(model_id);
    if (!rate) {
      unmatched++;
      log.error(
        { provider, model_id },
        'model_pricing sync: registered model has NO OpenRouter endpoint pricing — the slug likely does not exist on OpenRouter. Fix the models row.',
      );
      continue;
    }
    await pool.query(
      `INSERT INTO model_pricing
         (provider, model_id, input_per_m, output_per_m, cache_read_per_m, pricing_overrides, source, source_slug, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'openrouter-models-api', $2, NOW())
       ON CONFLICT (provider, model_id) DO UPDATE SET
         input_per_m       = EXCLUDED.input_per_m,
         output_per_m      = EXCLUDED.output_per_m,
         cache_read_per_m  = EXCLUDED.cache_read_per_m,
         pricing_overrides = EXCLUDED.pricing_overrides,
         source            = EXCLUDED.source,
         source_slug       = EXCLUDED.source_slug,
         synced_at         = EXCLUDED.synced_at`,
      [
        provider,
        model_id,
        rate.input,
        rate.output,
        rate.cacheRead,
        // Written unconditionally, INCLUDING null. A vendor that retires a
        // threshold must clear the stored one; leaving a stale array in place
        // would keep charging a band the vendor no longer publishes.
        rate.overrides == null ? null : JSON.stringify(rate.overrides),
      ],
    );
    synced++;
    log.info(
      {
        provider, model_id,
        input: rate.input, output: rate.output, cacheRead: rate.cacheRead,
        // Surfaced per model because a threshold changing shape is a billing
        // change, and this line is the only place it is observable.
        overrideBands: rate.overrides?.length ?? 0,
      },
      'model_pricing synced',
    );
  }
  log.info(
    { synced, unmatched, windowsSynced, modalitiesChanged, total: rows.length },
    'model_pricing sync complete',
  );

  await reportWindowCoverage(pool);
  await reportPricingCoverageAtBoot(pool);
}

/** Say out loud which approved models have no rate anywhere.
 *
 *  The sibling of reportWindowCoverage, for the same reason and with the same
 *  shape. An unpriced model does not fail: computeRowCost falls back to the
 *  conservative default rate, deliberately, so a usage row is never billed at
 *  $0. But the fallback is a guess wearing a number's clothes — it is charged
 *  at another vendor's rate, on every row, indefinitely, and every surface
 *  looks healthy while it happens.
 *
 *  Covers the whole approved catalog rather than the slugs this job syncs. The
 *  models this job CAN price are exactly the ones that self-heal; the ones that
 *  cannot are the direct-API models, whose rates are recorded by hand, and they
 *  are precisely the ones nothing else would ever notice. */
/** Say out loud which approved models still have no recorded context window.
 *
 *  Covers the whole approved catalog, not just the slugs this job syncs: the
 *  direct-API providers have no endpoint API to read, so their windows are
 *  recorded by hand and nothing else would ever notice one going missing. An
 *  unrecorded window degrades silently — the runtime falls back to a provider
 *  family floor, keeps logging ratios, and simply stops being allowed to retire
 *  a session — so absent a line like this, a model can sit un-actionable
 *  indefinitely and every surface still looks healthy. That is precisely how
 *  the column shipped inert for the entire catalog to begin with. */
async function reportWindowCoverage(pool: ReturnType<typeof getPool>): Promise<void> {
  const { rows } = await pool.query<{ provider: string; model_id: string }>(
    `SELECT provider, model_id FROM models
      WHERE status = 'approved' AND context_window IS NULL
      ORDER BY provider, model_id`,
  );
  if (rows.length === 0) {
    log.info({ missingWindows: 0 }, 'context-window coverage: every approved model has a recorded window');
    return;
  }
  log.error(
    {
      event: 'model_context_window_missing',
      missingWindows: rows.length,
      models: rows.map((r) => `${r.provider}:${r.model_id}`),
    },
    'context-window coverage: approved models have NO recorded context window — each one falls back to a provider floor and can never retire a saturated session. Record it with PUT /api/model-registry/:id/context-window.',
  );
}

// Main-module guard: the Cloud Run Job invokes this file directly
// (node dist/scripts/sync-model-pricing.js); tests import the exported
// pieces without triggering a live run.
if (require.main === module) {
  main().then(
    () => closePools().then(() => process.exit(0)),
    (err) => {
      log.error({ err }, 'model_pricing sync failed');
      closePools().finally(() => process.exit(1));
    },
  );
}
