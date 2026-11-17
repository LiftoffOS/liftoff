// Registry-driven tier→model maps, for every provider.
//
// Reads the latest approved model per tier from the `models` registry table and
// overlays it onto a provider's static TIER_MODELS seed, so onboarding a new
// model/tier is a registry INSERT — not a code change — and status='disabled'
// is a no-redeploy kill-switch. Refreshed every 60s so resolveModel() stays
// synchronous (reads the already-installed map; no per-call DB I/O).
//
// Every provider goes through this, not just the OpenRouter one. A provider
// without an overlay holds a SECOND source of truth for tier→model beside the
// registry, with nothing keeping the two in step. So each provider's static
// TIER_MODELS is a BOOTSTRAP fallback: what resolves before the first load
// lands, and what keeps resolving if a load fails.
//
// A provider's registry rows are addressed by the provider key it EXECUTES
// under, because after migration 450 those are the same value. They were not:
// GLM's rows sat under 'openrouter' and Grok's under 'grok' while the two
// executed as 'openrouter' and 'xai', so each vendor's rows were reachable only
// by a caller that knew the translation, and a caller that did not simply read
// nothing and kept the static seed.
//
// Callers still pass the providers they mean, one call per tier map. Widening
// one call to every OpenRouter-hosted provider would hand that provider's tier
// map to whichever vendor was registered most recently — the outcome migrations
// 322 and 380 exist to prevent, and the reason the four families are separate
// providers rather than one gateway.
//
// Migrations 322 and 380 refer to this file as `openrouter-tier-loader.ts`. That
// was its name; an applied migration is a record of what ran and is never
// edited, so the reference stays as written.
//
// The same refresh carries each model's CONTEXT WINDOW (`models.context_window`,
// migration 343) into a process-local cache, read by `llmClient.contextWindowFor`.
// A chat loop guards on how full the model's window is, and the window is a
// registry fact the loop cannot see: keeping it beside the tier map means the
// two are read from the same rows on the same timer, and a model onboarded by
// a registry row is sized here without a code change.
import { CONSERVATIVE_CONTEXT_WINDOW_TOKENS } from '@liftoffos/turn-bounds';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { LLMModelTier } from './types';

const REFRESH_MS = 60 * 1000; // 60s, matching other hot registry reads

/** What a loop assumes when the registry holds no window for the model it
 *  ran on: an unregistered or unsized model is treated as a 128k one, which
 *  is below every current frontier window, so the guard errs on the side of
 *  closing a turn early rather than letting one overflow.
 *
 *  Re-exported from the shared bound policy rather than written out again.
 *  Three loops used to carry their own answer to "what do we do about a model
 *  nobody sized", and they gave three different ones; a second copy of the
 *  number here would be the fourth. */
export const DEFAULT_CONTEXT_WINDOW = CONSERVATIVE_CONTEXT_WINDOW_TOKENS;

/** `provider:model_id` → context window, from the registry's approved rows.
 *  Keyed by the execution provider, which `models.provider` has been since
 *  migration 450. */
const contextWindows = new Map<string, number>();
/** `model_id` → context window, for a lookup whose provider key is not the
 *  registry's: the in-process OpenRouter client reads GLM's rows under 'glm'
 *  while it executes as 'openrouter'. A model id names one model whichever
 *  key its row sits under. */
const contextWindowsByModel = new Map<string, number>();

function windowKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Load every approved model's window for `registryProviders` into the cache.
 *  Returns the number of rows applied. A model whose window is null is not
 *  cached, so a lookup for it falls back to the default. */
export async function refreshRegistryContextWindows(registryProviders: readonly string[]): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ provider: string; model_id: string; context_window: number | string }>(
    `SELECT provider, model_id, context_window
       FROM models
      WHERE provider = ANY($1) AND status = 'approved' AND context_window IS NOT NULL`,
    [[...registryProviders]],
  );
  for (const r of rows) {
    const window = Number(r.context_window);
    if (!Number.isFinite(window) || window <= 0) continue;
    contextWindows.set(windowKey(r.provider, r.model_id), window);
    contextWindowsByModel.set(r.model_id, window);
  }
  return rows.length;
}

/** The registry's window for a model on a provider, or undefined when the
 *  cache holds none; a miss falls back to the model id alone.
 *
 *  This used to carry a second lookup for Claude over Google Vertex, which
 *  served the same registry rows under the 'anthropic' key. That provider is
 *  retired, and this is a REQUEST-time helper rather than an accounting one —
 *  nothing asks it about a historic row — so the branch goes with it. */
export function contextWindowFromRegistry(provider: string, model: string): number | undefined {
  const direct = contextWindows.get(windowKey(provider, model));
  if (direct !== undefined) return direct;
  return contextWindowsByModel.get(model);
}

/** `model_id` → the registry's request surface, as the keys that DIFFER from the
 *  conservative default (migration 560).
 *
 *  Keyed by model id alone rather than `provider:model`, deliberately: what a
 *  model accepts is a property of the model, not of the door it is reached
 *  through. The same Claude id served directly and through a gateway takes the
 *  same parameters, and keying by provider would mean a row filed under one key
 *  silently failing to answer for the other — the shape of the window bug
 *  migration 450 exists because of.
 *
 *  Held here only long enough to be PUSHED to the sinks — there is deliberately
 *  no getter. A reader that pulled from this module would be a second way to ask
 *  the same question, and the provider's own table is the one place that should
 *  answer it. */
const requestSurfaces = new Map<string, Record<string, unknown>>();

/** Load every approved model's request surface. Returns the number of rows. */
export async function refreshRegistryRequestSurfaces(
  sinks: readonly TierModelSink[],
  registryProviders: readonly string[],
): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ model_id: string; request_surface: Record<string, unknown> | null }>(
    `SELECT model_id, request_surface
       FROM models
      WHERE provider = ANY($1) AND status = 'approved' AND request_surface IS NOT NULL`,
    [[...registryProviders]],
  );
  for (const r of rows) {
    // A row holding anything but an object is ignored rather than installed: a
    // malformed surface that reached the merge could GRANT a capability by
    // accident, and a 400 on the first call is the one failure mode this whole
    // table exists to avoid.
    if (r.request_surface && typeof r.request_surface === 'object' && !Array.isArray(r.request_surface)) {
      requestSurfaces.set(r.model_id, r.request_surface);
    }
  }
  // Pushed to the sinks that keep a surface table, the same way the tier overlay
  // is, so this module never imports a provider and a provider never reads a
  // database. Sinks without one simply do not implement the method.
  const overlay = Object.fromEntries(requestSurfaces);
  for (const sink of sinks) sink.applyRegistrySurfaces?.(overlay);
  return rows.length;
}

/** Tests only: install windows without a database. */
export function _setRegistryContextWindowsForTests(entries: Record<string, number>): void {
  contextWindows.clear();
  contextWindowsByModel.clear();
  for (const [key, window] of Object.entries(entries)) {
    contextWindows.set(key, window);
    const model = key.slice(key.indexOf(':') + 1);
    if (model) contextWindowsByModel.set(model, window);
  }
}

// One timer per named refresh. Keyed rather than a single module-level handle
// because there is now more than one: the four providers refresh independently
// and starting one must not silently cancel another's.
const timers = new Map<string, NodeJS.Timeout>();

/** A provider that can take a tier→model overlay (typed structurally to avoid
 *  an import cycle with the provider modules). */
export interface TierModelSink {
  applyRegistryTierModels(overrides: Partial<Record<LLMModelTier, string>>): void;
  /** Optional: a provider that keeps a per-model REQUEST SURFACE — what each
   *  model will accept. Only Anthropic has one today, which is why this is
   *  optional rather than a second sink type: every caller already passes the
   *  full sink list and none of them should have to know which kind it holds. */
  applyRegistrySurfaces?(surfaces: Record<string, Record<string, unknown>>): void;
}

/** Load the latest approved model per tier for `registryProviders` and overlay
 *  it on every sink. Returns the number of tier rows applied.
 *
 *  Every sink gets the SAME overlay: a provider whose overlay is module-level
 *  (the two Anthropic providers and Google) is idempotent under repeated
 *  application, and one whose overlay is per-instance (OpenAI's purpose-keyed
 *  pool) needs each instance to receive it. Passing them all is correct for
 *  both, so no caller has to know which kind it holds. */
export async function refreshRegistryTierModels(
  sinks: readonly TierModelSink[],
  registryProviders: readonly string[],
): Promise<number> {
  const pool = getPool();
  // DISTINCT ON (tier) + ORDER BY created_at DESC → the newest approved model per tier.
  const { rows } = await pool.query<{ tier: LLMModelTier; model_id: string }>(
    `SELECT DISTINCT ON (tier) tier, model_id
       FROM models
      WHERE provider = ANY($1) AND status = 'approved' AND tier IS NOT NULL
      ORDER BY tier, created_at DESC`,
    [[...registryProviders]],
  );
  const overrides: Partial<Record<LLMModelTier, string>> = {};
  for (const r of rows) overrides[r.tier] = r.model_id;
  for (const sink of sinks) sink.applyRegistryTierModels(overrides);
  return rows.length;
}

/** Start the 60s refresh under `name`. Immediate best-effort load, then
 *  periodic. Never throws — the sinks keep their static TIER_MODELS seed until
 *  (and if) a load succeeds, and their last-known map if a later one fails.
 *  Re-starting an existing name replaces its timer rather than adding one. */
export function startRegistryTierRefresh(
  name: string,
  sinks: readonly TierModelSink[],
  registryProviders: readonly string[],
  ms: number = REFRESH_MS,
): void {
  refreshRegistryTierModels(sinks, registryProviders).then(
    (count) => log.info({ provider: name, count }, 'tier→model map loaded from registry'),
    (err) => log.warn({ provider: name, err }, 'tier load failed; using static TIER_MODELS'),
  );
  // The windows ride the same refresh, under their own promise: a failed
  // window load must not cost the tier map, nor the other way round.
  refreshRegistryContextWindows(registryProviders).then(
    (count) => log.info({ provider: name, count }, 'context windows loaded from registry'),
    (err) => log.warn({ provider: name, err }, 'context window load failed; using the default window'),
  );
  // And the request surfaces, under a third promise for the same reason. This is
  // the one whose failure is cheapest: a surface that does not load leaves the
  // code table answering, and the code table is conservative by construction.
  refreshRegistryRequestSurfaces(sinks, registryProviders).then(
    (count) => log.info({ provider: name, count }, 'request surfaces loaded from registry'),
    (err) => log.warn({ provider: name, err }, 'request surface load failed; using the static table'),
  );
  const existing = timers.get(name);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    refreshRegistryTierModels(sinks, registryProviders)
      .then((count) => log.debug({ provider: name, count }, 'tier→model map refreshed'))
      .catch((err) =>
        log.warn({ provider: name, err }, 'tier refresh failed; keeping last-known map'),
      );
    refreshRegistryContextWindows(registryProviders)
      .then((count) => log.debug({ provider: name, count }, 'context windows refreshed'))
      .catch((err) =>
        log.warn({ provider: name, err }, 'context window refresh failed; keeping last-known windows'),
      );
    refreshRegistryRequestSurfaces(sinks, registryProviders)
      .then((count) => log.debug({ provider: name, count }, 'request surfaces refreshed'))
      .catch((err) =>
        log.warn({ provider: name, err }, 'request surface refresh failed; keeping the last-known table'),
      );
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(name, timer);
}

/** Stop a named periodic refresh, or every one of them (tests / graceful
 *  shutdown). */
export function stopRegistryTierRefresh(name?: string): void {
  if (name === undefined) {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    return;
  }
  const timer = timers.get(name);
  if (timer) {
    clearInterval(timer);
    timers.delete(name);
  }
}
