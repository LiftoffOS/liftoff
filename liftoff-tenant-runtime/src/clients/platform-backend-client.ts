// Tenant-runtime client for platform-backend's /api/internal/* endpoints.
// Uses the shared TENANT_RUNTIME_SERVICE_TOKEN (the default token env for
// verifyServiceAuth on the PB side). Other TR→PB clients (agent-slack-client,
// connector-service callbacks) use their own purpose-specific tokens; this
// client is for endpoints the PB-side mounts under verifyServiceAuth() with
// the default token env.
//
// IMPORTANT: env vars are read LAZILY on every call, not captured at module
// import time. TENANT_RUNTIME_SERVICE_TOKEN is loaded from Secret Manager by
// loadSecretsToEnv() (infrastructure/secrets.ts), which runs AFTER module
// imports during boot. Module-level capture would pin the value to undefined
// and assertConfigured() would throw on every reconcile tick.

import { logger } from '../infrastructure/logging';
import type { PricingOverride } from '../llm/pricing-tiers';
import { getManagedSecret } from '../infrastructure/secret-store';

export interface CanonicalAgent {
  id: string;
  role: string;
  messagingNickname: string | null;
  status: string;
  currentVersion: number;
  triggerConfig: {
    type?: string;
    cronExpr?: string;
    timezone?: string;
    eventTopic?: string;
  } | null;
  integrations: unknown[];
}

interface Config {
  platformBackendUrl: string;
  serviceToken: string;
}

function readConfig(): Config {
  const platformBackendUrl = process.env.PLATFORM_BACKEND_URL;
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!platformBackendUrl) {
    throw new Error('PLATFORM_BACKEND_URL is required for platform-backend-client');
  }
  if (!serviceToken) {
    throw new Error('TENANT_RUNTIME_SERVICE_TOKEN is required for platform-backend-client');
  }
  return { platformBackendUrl, serviceToken };
}

/**
 * Authoritative snapshot of internal_agents for a tenant from platform-backend.
 * The reconciler uses this as the source of truth to heal cached_internal_agents
 * and Cloud Scheduler state. 15-second timeout — must not stall reconciler ticks.
 */
export async function listCanonicalAgents(tenantId: string): Promise<CanonicalAgent[]> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/agent-runtime/canonical-agents?tenantId=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`listCanonicalAgents HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json() as { agents: CanonicalAgent[] };
  logger.debug({ tenantId, count: json.agents.length }, 'listCanonicalAgents returned');
  return json.agents;
}

/**
 * Full event-payload-equivalent for one internal agent, used by the
 * reconciler's self-heal path. When the local mapping is missing, the
 * reconciler needs ALL the fields the original
 * `tenant.internal_agent.created` Pub/Sub event would have carried — not
 * just the minimal projection listCanonicalAgents returns.
 *
 * Returns null on 404 (agent doesn't exist or was soft-deleted). Throws on
 * any other error so the caller skips this row and tries again next tick.
 */
export async function fetchCanonicalAgentFull(
  tenantId: string,
  internalAgentId: string,
): Promise<Record<string, unknown> | null> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/agent-runtime/canonical-agents/${encodeURIComponent(internalAgentId)}/full?tenantId=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`fetchCanonicalAgentFull HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json() as { payload: Record<string, unknown> };
  return json.payload;
}

/**
 * Wire-form oversight settings the PB service-auth endpoint returns. Same
 * shape `oversightService.getOrCreateOversightSettings` produces in PB.
 * Returned for cache-aside lookups in hitl-enforcement when the local
 * `tenant_oversight_cache` row is missing (e.g. an oversight.updated event
 * was dropped or the tenant predates the pub/sub topic existing).
 */
export interface OversightSettingsWire {
  tenantId: string;
  autonomy: 'autonomous' | 'balanced' | 'controlled';
  escalation: 'exceptions' | 'important' | 'sensitive';
  communication: 'draft' | 'auto' | 'review';
  sensitiveWork: {
    customerCommunication: boolean;
    financialActions: boolean;
    dataChanges: boolean;
    externalPublishing: boolean;
    hiringDecisions: boolean;
    mergeToMain?: boolean;
  };
  currentVersion?: number;
  /** Which meaning of each setting the workspace chose under (platform-backend
   *  migration 508). Absent from an older control plane; the reader treats
   *  absent as 1. */
  escalationSemantics?: number;
  communicationSemantics?: number;
}

/**
 * Cache-aside fallback: fetch the authoritative oversight settings from PB.
 * Used by HitlEnforcementService.getOversightSettings when the local cache
 * is empty. PB's endpoint uses `getOrCreateOversightSettings`, so a 200
 * always returns a usable shape — no null, no 404 for "never configured".
 *
 * 5-second timeout: this sits on the agent-invocation critical path. If PB
 * is unreachable, the caller falls back to platform-safe defaults rather
 * than wedging the invocation; either way the silent-bypass-of-draft bug
 * (cache-empty → null → tool-interceptor early-exit) cannot recur.
 */
export async function fetchOversightSettings(
  tenantId: string,
): Promise<OversightSettingsWire | null> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/oversight/${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `fetchOversightSettings HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }
  return (await res.json()) as OversightSettingsWire;
}

/** One seeded classification row for a vendor-hosted MCP tool. `name` is the
 *  bare vendor tool name, or `<tool>:<operation>` on a meta-tool server. */
export interface SeededToolClassification {
  name: string;
  categories: string[];
}

export interface SeededToolClassifications {
  tools: SeededToolClassification[];
  /** For a meta-tool server: the tool whose argument names the operation. */
  operationKey: { tool: string; arg: string } | null;
}

/**
 * The a priori HITL classification seeds for one connector type — the global
 * rows of platform-backend's tool_classification_cache, written from each
 * vendor's public tool inventory before the first customer connects. The
 * vendor-MCP enumerator consults these BEFORE its name heuristics.
 *
 * 10-second timeout, and NEVER throws: a seed lookup must not stop enumeration.
 * On any failure it logs a warn and returns no seeds, and every tool then takes
 * the heuristic path exactly as it did before seeds existed.
 */
export async function fetchToolClassifications(integrationType: string): Promise<SeededToolClassifications> {
  const empty: SeededToolClassifications = { tools: [], operationKey: null };
  try {
    const { platformBackendUrl, serviceToken } = readConfig();
    const url = `${platformBackendUrl}/api/internal/tool-classifications/${encodeURIComponent(integrationType)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const json = (await res.json()) as {
      tools?: Array<{ name?: unknown; categories?: unknown }>;
      operationKey?: { tool?: unknown; arg?: unknown } | null;
    };
    const tools: SeededToolClassification[] = (json.tools ?? [])
      .filter((t) => typeof t.name === 'string' && t.name.length > 0)
      .map((t) => ({
        name: t.name as string,
        categories: Array.isArray(t.categories) ? t.categories.filter((c): c is string => typeof c === 'string') : [],
      }));
    const operationKey =
      json.operationKey && typeof json.operationKey.tool === 'string' && typeof json.operationKey.arg === 'string'
        ? { tool: json.operationKey.tool, arg: json.operationKey.arg }
        : null;
    return { tools, operationKey };
  } catch (err) {
    logger.warn(
      { integrationType, error: (err as Error).message },
      'fetchToolClassifications failed — enumerating without seeds',
    );
    return empty;
  }
}

/** One synced open-weights rate row from PB's model_pricing table. NUMERIC columns
 *  arrive as strings from node-postgres → JSON, so numbers may be string-typed. */
export interface ModelPricingRow {
  provider: string;
  model_id: string;
  input_per_m: string | number;
  output_per_m: string | number;
  cache_read_per_m: string | number | null;
  /** Conditional rate bands (prompt-token thresholds / UTC windows) that replace
   *  the flat rates above for matching requests. JSONB, so it arrives already
   *  parsed. Null when the vendor publishes none, and absent entirely from a
   *  platform-backend that predates the column — both mean "no bands", which is
   *  why the loader tests the value rather than the key. */
  pricing_overrides?: PricingOverride[] | null;
}

/** One registry-derived model→codename branding row (codename = TIER_MAP[tier]). */
export interface ModelBrandingRow {
  model_id: string;
  codename: string;
}

/** Registry snapshot served by platform-backend for the tenant-runtime. */
export interface ModelRegistrySnapshot {
  pricing: ModelPricingRow[];
  branding: ModelBrandingRow[];
  /** Per-model context windows. Models with no recorded window are OMITTED
   *  rather than sent as null, so an absence is unambiguous: the runtime may act
   *  destructively on a recorded window and never on a provider-family floor.
   *  Optional because a platform-backend that predates the column sends none. */
  windows?: ModelContextWindowRow[];
  /** The newest approved model per (provider, tier), keyed by the provider this
   *  plane DISPATCHES on.
   *
   *  This is the routing authority. Without it the only tier→model answer here
   *  was a hard-coded map per provider, i.e. a second source of truth beside the
   *  control plane's registry — and the two drifted a generation apart unnoticed,
   *  masked by the resolved model id that tenants used to carry. A codename in
   *  `branding` cannot substitute: it is a redaction label, it is many-to-one,
   *  and it carries no provider.
   *
   *  Optional because a platform-backend that predates the feed sends none, in
   *  which case every provider keeps its bootstrap seed. */
  tiers?: ModelTierRow[];
  /** model_id → what that model accepts, as the keys that differ from the
   *  conservative default (migration 560).
   *
   *  Keyed by model id alone, unlike the pricing and window feeds: what a model
   *  accepts is a property of the MODEL, not of the door it is reached through.
   *
   *  Optional because a platform-backend that predates the feed sends none, in
   *  which case the static surface table answers as it always has. */
  surfaces?: Record<string, Record<string, unknown>>;
  /** area → vendor for the platform's own LLM work. Optional because a
   *  platform-backend that predates the table sends none, in which case every
   *  area keeps its code fallback and nothing about routing changes. */
  platformVendors?: Record<string, string>;
}

/** One registry-derived (provider, tier) → model row. */
export interface ModelTierRow {
  provider: string;
  tier: string;
  model_id: string;
}

export interface ModelContextWindowRow {
  provider: string;
  model_id: string;
  context_window: number;
}

/** Registry snapshot from platform-backend (GET /api/internal/model-registry): synced
 *  open-weights rates AND tier-derived model→codename branding. TR has no direct access
 *  to the control-plane DB, so it polls this to drive BOTH its cost attribution and its
 *  customer-facing redaction from the same source as PB. Best-effort — the loader falls
 *  back to the static MODEL_PRICING / branding maps on failure. */
export async function fetchModelRegistry(): Promise<ModelRegistrySnapshot> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/model-registry`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`fetchModelRegistry HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as ModelRegistrySnapshot;
  logger.debug(
    { pricing: json.pricing.length, branding: json.branding.length, windows: json.windows?.length ?? 0 },
    'fetchModelRegistry returned',
  );
  return json;
}

export interface LateFeedbackFlag {
  feedbackId: string;
  approvalId: string | null;
  agentId: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}

/**
 * late-feedback flags for one agent since `sinceIso`. Each row carries `decision`; the
 * advisor filters to would_reject flags (a negative signal) and ignores would_approve
 * (positive). Throws on any non-2xx so the caller can fail CLOSED (never loosen on an
 * unconfirmable "no rejections").
 */
export async function listLateFeedbackFlags(
  tenantId: string,
  agentId: string,
  sinceIso: string,
): Promise<LateFeedbackFlag[]> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url =
    `${platformBackendUrl}/api/internal/late-feedback/flags` +
    `?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}&since=${encodeURIComponent(sinceIso)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`listLateFeedbackFlags HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as { flags: LateFeedbackFlag[] };
  return json.flags ?? [];
}

/**
 * set an agent's hitl level via PB (the source of truth for internal agents). A direct TR
 * write would be clobbered by the next lifecycle sync. `internalAgentId` is the PB internal_agents
 * id (resolve from the runtime id via internal_agent_runtime_mapping first).
 */
export async function updateAgentAutonomy(
  tenantId: string,
  internalAgentId: string,
  hitlLevel: number,
): Promise<void> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal-agents/_svc/${encodeURIComponent(internalAgentId)}/autonomy`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ tenantId, hitlLevel }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`updateAgentAutonomy HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}






/**
 * Ask the control plane to pause an agent.
 *
 * `internalAgentId` is the CONTROL-PLANE id (internal_agents.id), never the
 * runtime's agents.id — the two id spaces are disjoint and a runtime id
 * matches zero rows here with no error (INV-TR-010).
 *
 * The runtime does not pause agents by pausing their Cloud Scheduler jobs. The
 * agent's status is the single thing that stops an agent, it is what the
 * operator sees in the status column, and Resume sets it back — the reconciler
 * pauses and heals the jobs as a consequence of that status. Anything the
 * runtime recorded on the side would be state Resume could not clear.
 */
export async function pauseCanonicalAgent(
  tenantId: string,
  internalAgentId: string,
): Promise<boolean> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/agent-runtime/canonical-agents/${encodeURIComponent(internalAgentId)}/pause`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Service-Auth': serviceToken,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ tenantId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pauseCanonicalAgent HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return true;
}

// ── Capability discovery (the absorbed platform vendors) ──────────────────
// Both return platform-backend's capability-first, VENDOR-HIDDEN string — the
// same rendering the Liftoff assistant gets. search lists ranked capabilities
// with opaque handles; run executes one by handle. The vendor never crosses
// this boundary, so an agent absorbing the transcript cannot leak it.

export interface CapabilitySearchSpec {
  tenantId: string;
  /** The triggering person's account when a person drove the turn, so the
   *  control plane judges each vendor on the credential the RUN would use —
   *  the workspace's own connector of the vendor's type when connected, else
   *  the platform key. Omitted for an autonomous run, which executes on the
   *  platform credential. Never from the model's arguments. */
  accountId?: string;
  operation: string;
  entity: string;
  mode: 'own_account' | 'public_data';
  targetSystem?: string;
  availableInputs?: string[];
  requiredOutputFields?: string[];
}

export async function capabilitySearchViaBackend(spec: CapabilitySearchSpec): Promise<string> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/capability-discovery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`capabilitySearchViaBackend HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as { result?: string };
  return json.result ?? '';
}

/** The three dataset tools, answered by platform-backend as the text the
 *  model reads: a query over the records a fetch parked, an instruction
 *  answered over them, or the list of what this run holds. Nothing is
 *  dispatched to a vendor and nothing is charged as one. */
export async function runDatasetToolViaBackend(
  tenantId: string,
  tool: 'dataset_query' | 'dataset_extract' | 'dataset_list',
  input: Record<string, unknown>,
  /** The run (or conversation) whose datasets these are. */
  scopeId: string | undefined,
): Promise<string> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/capability-discovery/datasets/tool`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ tenantId, tool, input, ...(scopeId ? { scopeKind: 'agent_run', scopeId } : {}) }),
    // An extraction runs model calls over up to two thousand records.
    signal: AbortSignal.timeout(tool === 'dataset_extract' ? 180_000 : 30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`runDatasetToolViaBackend HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as { result?: string };
  return json.result ?? '';
}

/** An MCP result whose oversized successful TEXT blocks have been replaced by
 *  dataset views, or the reason there is not one. */
export type ParkedMcpResult =
  | { ok: true; result: unknown; parked: Array<{ datasetId: string; recordCount: number }> }
  | { ok: false; reason: string };

/**
 * Park an oversized tool result as a dataset of the run it belongs to.
 *
 * The rule, the records and the store all live in platform-backend, where the
 * datasets are and where the two in-process assistants already call it. What
 * comes back is the same MCP envelope with each oversized successful text
 * block replaced by the dataset's view — `_meta`, `isError`, every non-text
 * block and every block under the bound exactly as they went in.
 *
 * NEVER THROWS. A tool call that succeeded must not fail because the thing
 * that makes its result manageable did: `{ ok: false }` sends the caller to
 * its own fallback (spill to the sandbox, else truncate), which is what it did
 * before this route existed.
 *
 * Its own route rather than one on the capability router, and the reason is
 * the body: that router is mounted behind a 64kb limit, which would 413 almost
 * every payload worth parking.
 */
/** Park a BARE VALUE — a step output, not an MCP envelope.
 *
 *  THE TWO MODES OF THAT ROUTE ARE NOT INTERCHANGEABLE, and sending a value
 *  through the wrong one fails in two ways that both read as "nothing to park".
 *  `result` is an MCP envelope: the route walks its `content[]` for oversized
 *  TEXT blocks. A step output has no `content[]`, so an OBJECT passed that way
 *  validates and parks nothing, and an ARRAY — which is what a `collect: true`
 *  loop produces, the single most common oversized step output there is — is
 *  refused outright with `Expected object, received array`.
 *
 *  For example, a sweep that loops over several competitors and collects one
 *  research finding each gets "nothing parked" for the objects and HTTP 400 for
 *  the array from the offload that exists to keep them. With the one non-lossy
 *  option gone the engine falls back to compression, which can time out, and
 *  then to a positional cut — so findings are discarded and the digest says
 *  "research output lost in processing".
 *
 *  `text` is the model-facing serialization and `payload` the value behind it;
 *  the route prefers the value, so records land as records rather than as their
 *  own JSON. It answers with the rendered dataset view and the dataset it
 *  landed in. */
export async function parkValueViaBackend(
  tenantId: string,
  value: unknown,
  serialized: string,
  job: { scopeId: string },
  src: { label: string; source: string; sourceRef: string },
): Promise<
  { ok: true; view: string; parked: Array<{ datasetId: string; recordCount: number }> }
  | { ok: false; reason: string }
> {
  try {
    const { platformBackendUrl, serviceToken } = readConfig();
    const res = await fetch(`${platformBackendUrl}/api/internal/datasets/park`, {
      method: 'POST',
      headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        tenantId,
        scopeKind: 'agent_run',
        scopeId: job.scopeId,
        label: src.label,
        source: src.source,
        sourceRef: src.sourceRef,
        text: serialized,
        payload: value,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    const json = (await res.json()) as {
      text?: unknown;
      parked?: Array<{ datasetId: string; recordCount: number }>;
    };
    if (typeof json.text !== 'string') {
      return { ok: false, reason: 'the park route answered without text' };
    }
    return { ok: true, view: json.text, parked: json.parked ?? [] };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function parkToolResultViaBackend(
  tenantId: string,
  result: unknown,
  job: { scopeId: string },
  src: { label: string; source: string; sourceRef: string },
): Promise<ParkedMcpResult> {
  try {
    const { platformBackendUrl, serviceToken } = readConfig();
    const res = await fetch(`${platformBackendUrl}/api/internal/datasets/park`, {
      method: 'POST',
      headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        tenantId,
        scopeKind: 'agent_run',
        scopeId: job.scopeId,
        label: src.label,
        source: src.source,
        sourceRef: src.sourceRef,
        result,
      }),
      // Long enough for a multi-megabyte body over a service hop, short enough
      // that a run is not left waiting on the protection rather than the work.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    const json = (await res.json()) as { result?: unknown; parked?: Array<{ datasetId: string; recordCount: number }> };
    if (json.result === undefined) return { ok: false, reason: 'the park route answered without a result' };
    return { ok: true, result: json.result, parked: json.parked ?? [] };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Execute one capability by its opaque handle. `accountId` is the triggering
 *  user's account when a person drove the turn (enables the tenant's own
 *  connected-vendor key); omitted for autonomous runs, which run platform-
 *  funded. */
export async function runCapabilityViaBackend(
  tenantId: string,
  accountId: string | undefined,
  capabilityId: string,
  args: Record<string, unknown>,
  /** True ONLY when a human approved this exact call at the admission gate. It
   *  is the sole key that lets platform-backend run a write/outbound-class
   *  capability; a read runs without it. Never derived from the model. */
  approved = false,
  /** The ledger's identity for this act. Carried to the connector boundary so
   *  a repeat of the same act is replayed there rather than run again. */
  idempotencyKey?: string,
  /** The run (or conversation) a large result is parked for, and a dataset
   *  of it the model asked to add this run's records to. */
  job?: { scopeId?: string; appendTo?: string },
  /** The CONTROL-PLANE `internal_agents.id` of the agent making this call.
   *
   *  Named `internalAgentId`, not `agentId`, because INV-TR-010 says anything
   *  sent to the control plane emits the internal id under that name — the two
   *  id spaces are disjoint and a wrong-space id matches zero rows with no
   *  error (ADR-039).
   *
   *  Omitted when the reverse mapping misses, and deliberately never falls back
   *  to the runtime id: platform-backend writes this straight onto the cost
   *  row, so a runtime id here would render as an agent the workspace does
   *  not have. Absent, the spend books exactly as it does today and reports as
   *  unattributed, which is the truth. */
  internalAgentId?: string,
): Promise<CapabilityRunOutcome> {
  const { platformBackendUrl, serviceToken } = readConfig();
  const url = `${platformBackendUrl}/api/internal/capability-discovery/run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Service-Auth': serviceToken, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      tenantId,
      capabilityId,
      args,
      ...(accountId ? { accountId } : {}),
      ...(approved ? { approved: true } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(job?.scopeId ? { scopeKind: 'agent_run', scopeId: job.scopeId } : {}),
      ...(job?.appendTo ? { appendTo: job.appendTo } : {}),
      ...(internalAgentId ? { internalAgentId } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`runCapabilityViaBackend HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = (await res.json()) as {
    result?: string;
    outcome?: { ok?: boolean; kind?: CapabilityRunFailureKind; empty?: boolean };
  };
  const text = json.result ?? '';
  // `outcome` is the typed status; a response without one predates it and
  // carried only the model-facing text, which was always returned as a success.
  if (json.outcome && json.outcome.ok === false) {
    return { ok: false, kind: json.outcome.kind ?? 'no_result', text };
  }
  // `empty` says the capability ran and answered nothing usable. A response
  // without it predates the flag; its text was returned as an answer, and
  // still is.
  return { ok: true, empty: json.outcome?.empty === true, text };
}

/** What running a capability produced. The text is what the model sees either
 *  way — neutral on failure, so it cannot name or guess a cause, except for
 *  `invalid_arguments`, where it carries the source's account of what is wrong
 *  with the arguments so the model can correct them, and `handoff`, where it
 *  names the next candidate for the same need (a fresh handle and the
 *  arguments it takes) so the model's next call is directed rather than a
 *  guess — and the status is the truth of whether the capability ran, which
 *  the tool result, the audit row and the resume's failure routing all need.
 *  A refusal rendered as ordinary text used to count as a success at every
 *  layer above the executor, so an operator's approved send could report done
 *  without sending. On a success, `empty` is the truth of whether it ANSWERED:
 *  a run that returned nothing usable is ok and empty, and a caller counting
 *  useful results counts `ok && !empty`. */
export type CapabilityRunFailureKind = 'refused' | 'requires_approval' | 'no_result' | 'invalid_arguments' | 'handoff';
export type CapabilityRunOutcome =
  | { ok: true; empty: boolean; text: string }
  | { ok: false; kind: CapabilityRunFailureKind; text: string };
