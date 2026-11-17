// Background loader for the Workspace AI vendor map. Reads the newest approved
// model per (provider, tier) from the `models` registry and overlays it onto
// WORKSPACE_AI_VENDORS, so what a tier means for a vendor is a registry row
// rather than a code edit — the same thing registry-tier-loader does for each
// provider's TIER_MODELS, applied to the third place model names used to live.
//
// Refreshed every 60s so buildWorkspaceAiPolicy and effectiveModelConfig stay
// synchronous (they read the already-installed map; no per-call DB I/O). The
// static seed in workspace-ai-vendors.ts is the fallback until the first load
// succeeds, and the last-known map survives a failed refresh.
//
// This changes what a NEW policy write stamps. Tenants already stamped keep
// their materialized model_configs row until scripts/restamp-workspace-ai-
// policies.ts runs, exactly as they do after an edit to the seed.
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  applyRegistryVendorModels,
  workspaceAiDisplayedModelIds,
  workspaceAiVendorCoding,
  workspaceAiVendorModelNames,
  type WorkspaceAiTier,
  type WorkspaceAiVendor,
  type WorkspaceAiVendorCoding,
} from './workspace-ai-vendors';

const REFRESH_MS = 60 * 1000; // 60s, matching the other hot registry reads
let timer: NodeJS.Timeout | null = null;

interface VendorTierRow {
  provider: string;
  tier: WorkspaceAiTier;
  model_id: string;
}

/** Load (provider, tier) → newest approved model and install the overlay.
 *  Returns the number of (vendor, tier) pairs replaced. */
export async function refreshWorkspaceAiVendorModels(): Promise<number> {
  const pool = getPool();
  // DISTINCT ON (provider, tier) + ORDER BY created_at DESC → the newest
  // approved model per tier, PER REGISTRY PROVIDER. Grouping by provider is
  // what keeps the four OpenRouter-served vendors apart from each other and
  // from GLM; they share a runtime provider but not a registry key.
  const { rows } = await pool.query<VendorTierRow>(
    `SELECT DISTINCT ON (provider, tier) provider, tier, model_id
       FROM models
      WHERE status = 'approved' AND tier IS NOT NULL
      ORDER BY provider, tier, created_at DESC`,
  );
  const byRegistryProvider = new Map<string, Partial<Record<WorkspaceAiTier, string>>>();
  for (const r of rows) {
    const entry = byRegistryProvider.get(r.provider) ?? {};
    entry[r.tier] = r.model_id;
    byRegistryProvider.set(r.provider, entry);
  }
  const applied = applyRegistryVendorModels(byRegistryProvider);
  // After the overlay, so the names describe the map just installed. A failure
  // here keeps the last-known names and does not undo the overlay above.
  try {
    await refreshWorkspaceAiModelNames();
  } catch (err) {
    log.warn({ err }, 'workspace AI model names load failed; keeping last-known names');
  }
  return applied;
}

// ── Display names for the Workspace AI card ──────────────────────────────────
//
// model_id → models.name for every model the live map points at, refreshed on
// the same tick as the overlay. Read straight from the table, NOT through
// /api/model-registry, whose branding middleware rewrites names to codenames:
// the card shows a named vendor's real model names (owner decision). `models`
// is platform-wide, not tenant data, so this is the loader's own unscoped pool
// read, like the overlay query above.
let modelNames: ReadonlyMap<string, string> = new Map();
let namesLoaded = false;
let namesInFlight: Promise<void> | null = null;

/** Reload the names of the models the live vendor map currently names: every
 *  tier model and every Frontier model. Any registry status, and any tier
 *  including NULL: the name labels the model the vendor offers, whether or not
 *  its row is the approved one for a tier. */
export async function refreshWorkspaceAiModelNames(): Promise<void> {
  const ids = workspaceAiDisplayedModelIds();
  const { rows } = await getPool().query<{ model_id: string; name: string | null }>(
    'SELECT model_id, name FROM models WHERE model_id = ANY($1::text[])',
    [ids],
  );
  const next = new Map<string, string>();
  for (const r of rows) {
    if (r.name) next.set(r.model_id, r.name);
  }
  modelNames = next;
  namesLoaded = true;
}

/** The name cache, loaded if this process has not loaded it yet.
 *
 *  Served from the cache the 60s refresh keeps. Only a process that has not
 *  loaded names yet (boot, or a process that never started the refresh) reads
 *  the table here, once, shared by concurrent callers. Never throws: a failed
 *  read leaves the names it has. */
async function namesFromCache(): Promise<(modelId: string) => string | undefined> {
  if (!namesLoaded) {
    namesInFlight ??= refreshWorkspaceAiModelNames().finally(() => {
      namesInFlight = null;
    });
    try {
      await namesInFlight;
    } catch (err) {
      log.warn({ err }, 'workspace AI model names load failed; serving without names');
    }
  }
  return (modelId) => modelNames.get(modelId);
}

/** Vendor → model display names for GET /api/tenants/:id/workspace-ai. A
 *  vendor it cannot name is an empty list. */
export async function getWorkspaceAiVendorModels(): Promise<Record<WorkspaceAiVendor, string[]>> {
  return workspaceAiVendorModelNames(await namesFromCache());
}

/** Vendor → coding tool (and, for OpenCode, its model's display name) for
 *  GET /api/tenants/:id/workspace-ai. A model it cannot name is omitted. */
export async function getWorkspaceAiVendorCoding(): Promise<
  Record<WorkspaceAiVendor, WorkspaceAiVendorCoding>
> {
  return workspaceAiVendorCoding(await namesFromCache());
}

/** Start the 60s refresh. Immediate best-effort load, then periodic. Never
 *  throws — the vendor map keeps its static seed until (and if) a load
 *  succeeds, and its last-known values if a later one fails. */
export function startWorkspaceAiVendorRefresh(ms: number = REFRESH_MS): void {
  refreshWorkspaceAiVendorModels().then(
    (applied) => log.info({ applied }, 'workspace AI vendor map loaded from registry'),
    (err) => log.warn({ err }, 'workspace AI vendor load failed; using the static seed'),
  );
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refreshWorkspaceAiVendorModels()
      .then((applied) => log.debug({ applied }, 'workspace AI vendor map refreshed'))
      .catch((err) =>
        log.warn({ err }, 'workspace AI vendor refresh failed; keeping last-known map'),
      );
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}
