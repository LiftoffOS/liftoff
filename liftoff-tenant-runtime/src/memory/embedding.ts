// Memory Embedding Service
//
// Thin wrapper over @liftoffos/embedding. The embedding client is the
// single source of truth for each provider's NATIVE output dimension —
// no Matryoshka truncation. Every consumer DB schema (memories,
// agent_skills, connector_content, ...) sizes its embedding column to
// match the active provider's native dim via the schema cascade
// (migration 259 + src/bootstrap/embedding-dim-bind.ts).
//
// A schema/provider mismatch — the schema saying vector(1536) while the
// provider returns 768d, the drift migration 258 fixed — silently stores
// NULL on every INSERT. That is why this module fails LOUDLY on dim
// mismatch (EmbeddingDimMismatchError) rather than degrading.
//
// Public callers see two flavors of the same call:
//   generateEmbedding(text, opts)            → number[]                  (legacy shape)
//   generateEmbeddingDetailed(text, opts)    → { embedding, model, provider, dim }
// (and the matching batch variants). Use the detailed variant when the
// caller persists embedding_model alongside the vector.
//
// Layered on top of the shared client:
//   - Per-tenant entitlements lookup via getEntitlementsClient().getModelForTask
//   - embedding_cache table (content_hash, embedding_model) hit/miss
//   - usage_ledger writes (recordUsage) wired via embeddingClient.onUsage

import { createHash, randomUUID } from 'crypto';
import OpenAI from 'openai';
import {
  embeddingClient,
  OpenAIEmbeddingProvider,
  GoogleEmbeddingProvider,
  VoyageEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderClient,
  type EmbeddingUsageEvent,
  type EmbeddingTaskType,
} from '@liftoffos/embedding';
import { log } from '../infrastructure/logging';
import { getEntitlementsClient } from '../entitlements-client/service';
import { pool } from '../infrastructure/database';
import { incCounter } from './metrics';
import { usageLedgerService } from '../usage-ledger/service';
import { getManagedSecret } from '../infrastructure/secret-store';

// Re-export the alias types tenant-runtime callers already use.
export type { EmbeddingProvider, EmbeddingTaskType };

const EMBEDDING_CACHE_DISABLED = process.env.MEM_EMBEDDING_CACHE_DISABLED === '1';

/** Native output dimension per provider. The embedding client REQUESTS
 *  this dim verbatim from each provider — no client-side Matryoshka
 *  truncation. Consumer DB schemas (memories, agent_skills,
 *  connector_content) must size their vector columns to match the
 *  active provider's nativeDim. See migration 259 + the dim-bind
 *  bootstrap verifier. */
interface EmbeddingModelConfig {
  provider: EmbeddingProvider;
  model: string;
  nativeDim: number;
}

const EMBEDDING_CONFIGS: Record<EmbeddingProvider, EmbeddingModelConfig> = {
  // text-embedding-3-small natively 1536d. Matryoshka-capable, but we
  // request native — the storage column is sized for it.
  openai: { provider: 'openai', model: 'text-embedding-3-small', nativeDim: 1536 },
  // gemini-embedding-001 — model can produce up to 3072d internally but
  // Vertex AI's outputDimensionality API caps at 768 (its error reads:
  // "supported range is from 1 (inclusive) to 769 (exclusive)").
  // We use 768d as the de facto native because that's the maximum we
  // can actually request. Migration 263 reverts the column to vector(768).
  google: { provider: 'google', model: 'gemini-embedding-001',   nativeDim: 768 },
  // voyage-4 native 1024d. Matryoshka set {256, 512, 1024, 2048}.
  voyage: { provider: 'voyage', model: 'voyage-4',               nativeDim: 1024 },
};

/** Public helper — returns the native dim for a provider. Throws on
 *  unknown provider. */
export function getProviderNativeDim(provider: EmbeddingProvider): number {
  const cfg = EMBEDDING_CONFIGS[provider];
  if (!cfg) throw new Error(`Unknown embedding provider: ${provider}`);
  return cfg.nativeDim;
}

/** Returns the model string for a provider — used by callers that need
 *  to record embedding_model when no embedding was generated (sensitive
 *  classification, embed failure). The recorded value is the model that
 *  WOULD have been used; truthful provenance. */
export function getProviderModel(provider: EmbeddingProvider): string {
  const cfg = EMBEDDING_CONFIGS[provider];
  if (!cfg) throw new Error(`Unknown embedding provider: ${provider}`);
  return cfg.model;
}

const GCP_PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const GCP_LOCATION = process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-west1';

const VALID_PROVIDERS: ReadonlySet<EmbeddingProvider> = new Set(['openai', 'google', 'voyage']);

/** Returns 'google' as the platform documented default. Used by the
 *  entitlements-resolution code path when no override is set and no
 *  tenant-specific provider is configured. */
export function getDefaultProvider(): EmbeddingProvider {
  const raw = process.env.EMBEDDING_PROVIDER;
  if (raw && VALID_PROVIDERS.has(raw as EmbeddingProvider)) {
    return raw as EmbeddingProvider;
  }
  return 'google';
}

/** Returns the explicit EMBEDDING_PROVIDER override if set, otherwise
 *  undefined so the shared client falls back to defaultPreference. */
function explicitDefaultProvider(): EmbeddingProvider | undefined {
  const raw = process.env.EMBEDDING_PROVIDER;
  if (raw && VALID_PROVIDERS.has(raw as EmbeddingProvider)) {
    return raw as EmbeddingProvider;
  }
  return undefined;
}

/** The platform-default native dim, evaluated at module load. This is
 *  what the schema-cascade migration writes into ALTER COLUMN TYPE
 *  halfvec(N). Bootstrap (src/bootstrap/embedding-dim-bind.ts) asserts
 *  every embedding column equals this. */
export const ACTIVE_DIM: number = EMBEDDING_CONFIGS[getDefaultProvider()].nativeDim;

/** Loud failure when a provider returns a vector whose length disagrees
 *  with EMBEDDING_CONFIGS. The migration-258 dim drift is the lesson here
 *  — silent-NULL inserts are not acceptable. Callers should log and
 *  treat as embedding-skip (record NULL embedding + audit) rather than
 *  propagate to the request. */
export class EmbeddingDimMismatchError extends Error {
  constructor(
    public readonly provider: EmbeddingProvider,
    public readonly model: string,
    public readonly expectedDim: number,
    public readonly actualDim: number,
  ) {
    super(
      `Embedding dim mismatch: provider=${provider} model=${model} ` +
      `expected ${expectedDim}, got ${actualDim}. ` +
      `EMBEDDING_CONFIGS may be stale, or the provider changed its API.`,
    );
    this.name = 'EmbeddingDimMismatchError';
  }
}

// ── One-time init: register providers + onUsage callback ─────────────
let clientInitialized = false;
function ensureInitialized(): void {
  if (clientInitialized) return;

  // Sanity check the config table at init. A field swap could lead to
  // requesting a wrong dim from every provider; catch it before traffic.
  for (const [name, cfg] of Object.entries(EMBEDDING_CONFIGS)) {
    if (!Number.isInteger(cfg.nativeDim) || cfg.nativeDim <= 0) {
      throw new Error(
        `EMBEDDING_CONFIGS['${name}'].nativeDim is invalid (${cfg.nativeDim}). ` +
        `Provider configs must declare a positive integer dimension.`,
      );
    }
  }

  // Only register providers whose credentials are present. The OpenAI SDK
  // constructor THROWS if OPENAI_API_KEY isn't set, so eagerly constructing
  // `new OpenAI()` would kill calls targeting Google/Voyage when running
  // without an OpenAI key. Match the platform-backend init.ts pattern.
  const providers: Partial<Record<EmbeddingProvider, EmbeddingProviderClient>> = {};
  if (getManagedSecret('OPENAI_API_KEY')) {
    providers.openai = new OpenAIEmbeddingProvider(new OpenAI({ apiKey: getManagedSecret('OPENAI_API_KEY') }));
  }
  if (GCP_PROJECT) {
    providers.google = new GoogleEmbeddingProvider({ projectId: GCP_PROJECT, location: GCP_LOCATION });
  }
  if (process.env.VOYAGE_API_KEY) {
    providers.voyage = new VoyageEmbeddingProvider(process.env.VOYAGE_API_KEY);
  }
  embeddingClient.init({
    providers,
    defaultProvider: explicitDefaultProvider(),
    defaultPreference: ['google', 'voyage', 'openai'],
  });

  // Persist to usage_ledger — tenant-runtime's existing cost path.
  embeddingClient.onUsage(async (event: EmbeddingUsageEvent) => {
    const tenantId = event.context?.tenantId;
    const agentId = event.context?.agentId || '00000000-0000-0000-0000-000000000000';
    if (!tenantId) return;  // No tenant scope = no ledger row (matches existing behaviour)
    await usageLedgerService.recordUsage({
      tenantId,
      agentId,
      workflowId: null,
      actionId: randomUUID(),
      eventType: 'embedding_generation',
      // ONE action credit per embedding call. `credits` is the ledger's action
      // unit; writing the raw input-token count here put a third incompatible
      // unit into a single column (alongside milli-USD sandbox ticks and action
      // counts) and made 87% of one tenant's "burn" an artifact of tokenizer
      // size. Cost truth for embeddings is the control plane's cost-attribution
      // path — this ledger is activity telemetry. Token counts live in
      // metadata, where their unit is stated.
      credits: 1,
      metadata: {
        provider: event.provider,
        model: event.model,
        success: event.success,
        error: event.error,
        purpose: event.context?.purpose ?? 'embedding_generation',
        // The ledger row has no invocation COLUMN — it is activity telemetry,
        // not the cost path — so the run lands in metadata where it can still
        // answer "what did this run spend".
        ...(event.context?.invocationId ? { invocationId: event.context.invocationId } : {}),
        inputTokens: event.inputTokens,
        unit: 'action_credit',
      },
    }).catch((err: Error) =>
      log.warn({ err: err.message }, 'Non-fatal: embedding usage tracking failed'),
    );
  });
  clientInitialized = true;
}

/** Test seam onto the one-time init, so the usage hook registered above can be
 *  exercised without driving a real embedding call. Underscore-prefixed by the
 *  repo convention for exported-for-tests. */
export function _ensureEmbeddingClientInitialized(): void {
  clientInitialized = false;
  ensureInitialized();
}

// Exported (WS-D) so other modules in src/memory can deserialize pgvector
// values without duplicating the string/array branch logic.
export function parseVectorFromPg(value: string | number[]): number[] {
  if (Array.isArray(value)) return value;
  return JSON.parse(value);
}

// ── Public API ───────────────────────────────────────────────────────

/** Caller-supplied options for generateEmbedding* variants.
 *
 *  Tenants pick the provider via entitlements; the platform picks the
 *  model. `provider` can be overridden per call (tests, forced
 *  selection); `model` is not user-selectable — it's always
 *  EMBEDDING_CONFIGS[provider].model. */
export interface GenerateEmbeddingOptions {
  tenantId?: string;
  agentId?: string;
  /** Owning invocation, carried into the usage context so a retrieval
   *  embedding is attributable to the run that asked for it rather than only
   *  to the tenant and agent. */
  invocationId?: string;
  purpose?: string;
  provider?: EmbeddingProvider;
  /** Asymmetric retrieval hint. Per @liftoffos/embedding docs, Google
   *  and Voyage give a 3-7 MTEB-point lift on cosine retrieval when
   *  query and document are embedded with different taskTypes. OpenAI
   *  silently ignores. Defaults to undefined (symmetric). */
  taskType?: EmbeddingTaskType;
  /** Per-attempt HTTP deadline for this call, in ms. Unset: query-time calls
   *  (`taskType: 'retrieval_query'`) get queryEmbeddingBounds(), everything
   *  else keeps the transport default (30s; the OpenAI SDK's 10 min). */
  timeoutMs?: number;
  /** Max transient retries for this call. Unset: as for timeoutMs. */
  retries?: number;
}

/**
 * Bounds for a query-time embedding: one short string, embedded while a run or
 * a search waits on it. The transport defaults (30s per attempt, 2 retries; the
 * OpenAI SDK's 10 minutes) suit a background indexing batch and are far too
 * long here — a request on a dead pooled connection waits for the whole timer.
 * Every query-time caller already degrades without a vector (lexical / recency
 * retrieval), so a fast failure beats a slow one. 5s is an order of magnitude
 * above a normal single-input embed; one retry absorbs one transient failure.
 * Env-overridable for tests and emergencies.
 */
export function queryEmbeddingBounds(): { timeoutMs: number; retries: number } {
  const timeoutMs = Number.parseInt(process.env.MEM_QUERY_EMBED_TIMEOUT_MS ?? '', 10);
  const retries = Number.parseInt(process.env.MEM_QUERY_EMBED_RETRIES ?? '', 10);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000,
    retries: Number.isFinite(retries) && retries >= 0 ? retries : 1,
  };
}

/** The transport bounds a call runs with: explicit ones win, query-time calls
 *  default to queryEmbeddingBounds(), the rest keep the transport defaults. */
function transportBounds(options: GenerateEmbeddingOptions | undefined): { timeoutMs?: number; retries?: number } {
  const queryDefaults = options?.taskType === 'retrieval_query' ? queryEmbeddingBounds() : undefined;
  const timeoutMs = options?.timeoutMs ?? queryDefaults?.timeoutMs;
  const retries = options?.retries ?? queryDefaults?.retries;
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
  };
}

export interface EmbeddingResult {
  embedding: number[];
  /** Actual model that produced this embedding. Always equals
   *  EMBEDDING_CONFIGS[provider].model — the canonical model for the
   *  resolved provider. */
  model: string;
  /** Actual provider that served the request. */
  provider: EmbeddingProvider;
  /** Vector length. Equals EMBEDDING_CONFIGS[provider].nativeDim on the
   *  happy path; otherwise the call threw EmbeddingDimMismatchError. */
  dim: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  model: string;
  provider: EmbeddingProvider;
  dim: number;
}

/** Honor the global kill-switch when forwarding taskType. */
function resolveTaskType(explicit: EmbeddingTaskType | undefined): EmbeddingTaskType | undefined {
  if (process.env.MEM_EMBED_TASKTYPE_DISABLED === '1') return undefined;
  return explicit;
}

/** Resolves provider, model, and dim for a single embed call.
 *
 *  Provider:
 *    explicit options.provider > tenant entitlement > platform default.
 *
 *  Model and dim are derived from EMBEDDING_CONFIGS[provider] —
 *  the embedding client is the source of truth. */
async function resolveProviderModelDim(
  options: GenerateEmbeddingOptions | undefined,
): Promise<{ provider: EmbeddingProvider; model: string; dimensions: number }> {
  let provider = options?.provider;
  if (!provider && options?.tenantId) {
    const taskConfig = await getEntitlementsClient().getModelForTask(options.tenantId, 'embedding');
    if (taskConfig?.provider) {
      // Legacy compat: pre-Phase 2 entitlements tagged 'anthropic' for
      // the Voyage partnership. Translate so old rows don't silently
      // degrade to the platform default.
      const normalized = taskConfig.provider === 'anthropic' ? 'voyage' : taskConfig.provider;
      if (EMBEDDING_CONFIGS[normalized as EmbeddingProvider]) {
        provider = normalized as EmbeddingProvider;
      } else {
        log.warn(
          { tenantId: options.tenantId, entitlementProvider: taskConfig.provider },
          'Entitlement specified unknown embedding provider, falling back to default',
        );
      }
    }
  }
  provider = provider ?? getDefaultProvider();
  const config = EMBEDDING_CONFIGS[provider];
  return { provider, model: config.model, dimensions: config.nativeDim };
}

async function embedOneInternal(
  text: string,
  options?: GenerateEmbeddingOptions,
): Promise<EmbeddingResult> {
  ensureInitialized();

  const { provider, model, dimensions } = await resolveProviderModelDim(options);

  // Cache lookup
  const contentHash = createHash('sha256').update(text).digest('hex');
  if (!EMBEDDING_CACHE_DISABLED) {
    try {
      const cached = await pool.query<{ embedding: string | number[] }>(
        `UPDATE embedding_cache
         SET last_used_at = NOW(), hit_count = hit_count + 1
         WHERE content_hash = $1 AND embedding_model = $2
         RETURNING embedding`,
        [contentHash, model],
      );
      if (cached.rows.length > 0) {
        const cachedVec = parseVectorFromPg(cached.rows[0].embedding);
        // Stale-dim guard: old cache rows from before a provider switch
        // may not match the current dim. Treat as miss and re-embed; the
        // INSERT will conflict-skip and the stale row stays harmless.
        if (cachedVec.length === dimensions) {
          incCounter('embedding_cache_hit_total', { __name: 'embedding_cache_hit_total', model });
          return { embedding: cachedVec, model, provider, dim: cachedVec.length };
        }
        log.warn(
          { model, cachedDim: cachedVec.length, expectedDim: dimensions },
          'embedding cache hit with stale dim, treating as miss',
        );
      }
      incCounter('embedding_cache_miss_total', { __name: 'embedding_cache_miss_total', model });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'embedding cache lookup failed (non-fatal)');
    }
  }

  // Embed via shared client. Attribution + tenantId for the onUsage callback.
  const response = await embeddingClient.embed({
    input: text,
    model,
    dimensions,
    provider,
    taskType: resolveTaskType(options?.taskType),
    ...transportBounds(options),
    context: {
      ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      purpose: options?.purpose ?? 'embedding_generation',
    },
  });
  const embedding = response.embeddings[0];
  const actualProvider = response.provider as EmbeddingProvider;
  const actualModel = response.model;

  // Dim verification — loud failure if the provider's response disagrees
  // with the config we trusted. This is the migration-258 lesson encoded.
  const expectedDim = EMBEDDING_CONFIGS[actualProvider]?.nativeDim ?? dimensions;
  if (embedding.length !== expectedDim) {
    throw new EmbeddingDimMismatchError(actualProvider, actualModel, expectedDim, embedding.length);
  }

  // Cache write (fire-and-forget). Stale-dim rows from a previous
  // provider stay because (content_hash, embedding_model) is composite;
  // they're invalidated by the model filter on the next read.
  if (!EMBEDDING_CACHE_DISABLED) {
    pool.query(
      `INSERT INTO embedding_cache (content_hash, embedding_model, embedding, hit_count)
       VALUES ($1, $2, $3::vector, 0)
       ON CONFLICT (content_hash, embedding_model) DO NOTHING`,
      [contentHash, actualModel, JSON.stringify(embedding)],
    ).catch(err => log.warn({ err: err.message }, 'embedding cache write failed (non-fatal)'));
  }

  return { embedding, model: actualModel, provider: actualProvider, dim: embedding.length };
}

/** Legacy-shape API. Returns the vector only. Callers that persist
 *  embedding_model alongside the row should use generateEmbeddingDetailed
 *  to get the truthful model string. */
export async function generateEmbedding(
  text: string,
  options?: GenerateEmbeddingOptions,
): Promise<number[]> {
  return (await embedOneInternal(text, options)).embedding;
}

/** Detailed-shape API. Returns the vector plus the actual model and
 *  provider that served the request — use this when persisting the row
 *  so embedding_model is truthful (not the platform default). */
export async function generateEmbeddingDetailed(
  text: string,
  options?: GenerateEmbeddingOptions,
): Promise<EmbeddingResult> {
  return embedOneInternal(text, options);
}

async function embedBatchInternal(
  texts: string[],
  options?: GenerateEmbeddingOptions,
): Promise<EmbeddingBatchResult> {
  ensureInitialized();
  if (texts.length === 0) {
    const fallbackProvider = options?.provider ?? getDefaultProvider();
    return {
      embeddings: [],
      model: EMBEDDING_CONFIGS[fallbackProvider].model,
      provider: fallbackProvider,
      dim: 0,
    };
  }

  const { provider, model, dimensions } = await resolveProviderModelDim(options);

  // Bulk cache lookup keyed by (content_hash, model).
  const hashes = texts.map(t => createHash('sha256').update(t).digest('hex'));
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const missIndices: number[] = [];
  const missTexts: string[] = [];
  const missHashes: string[] = [];

  if (!EMBEDDING_CACHE_DISABLED) {
    try {
      const cached = await pool.query<{ content_hash: string; embedding: string | number[] }>(
        `UPDATE embedding_cache
         SET last_used_at = NOW(), hit_count = hit_count + 1
         WHERE content_hash = ANY($1) AND embedding_model = $2
         RETURNING content_hash, embedding`,
        [hashes, model],
      );
      const cacheMap = new Map<string, number[]>();
      for (const row of cached.rows) {
        const vec = parseVectorFromPg(row.embedding);
        // Stale-dim guard (see embedOneInternal). Drop stale entries
        // silently; they get re-embedded on this pass.
        if (vec.length === dimensions) cacheMap.set(row.content_hash, vec);
      }
      for (let i = 0; i < texts.length; i++) {
        const hit = cacheMap.get(hashes[i]);
        if (hit) results[i] = hit;
        else { missIndices.push(i); missTexts.push(texts[i]); missHashes.push(hashes[i]); }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'embedding cache batch lookup failed (non-fatal)');
      for (let i = 0; i < texts.length; i++) {
        missIndices.push(i); missTexts.push(texts[i]); missHashes.push(hashes[i]);
      }
    }
  } else {
    for (let i = 0; i < texts.length; i++) {
      missIndices.push(i); missTexts.push(texts[i]); missHashes.push(hashes[i]);
    }
  }

  const cacheHitCount = texts.length - missIndices.length;
  if (cacheHitCount > 0) incCounter('embedding_cache_hit_total', { __name: 'embedding_cache_hit_total', model }, cacheHitCount);
  if (missIndices.length > 0) incCounter('embedding_cache_miss_total', { __name: 'embedding_cache_miss_total', model }, missIndices.length);

  let actualModel = model;
  let actualProvider = provider;

  if (missTexts.length > 0) {
    const response = await embeddingClient.embed({
      input: missTexts,
      model,
      dimensions,
      provider,
      taskType: resolveTaskType(options?.taskType),
      ...transportBounds(options),
      context: {
        ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
        ...(options?.agentId ? { agentId: options.agentId } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        purpose: options?.purpose ?? 'embedding_batch',
      },
    });
    actualModel = response.model;
    actualProvider = response.provider as EmbeddingProvider;

    const expectedDim = EMBEDDING_CONFIGS[actualProvider]?.nativeDim ?? dimensions;
    for (let j = 0; j < missIndices.length; j++) {
      const vec = response.embeddings[j];
      if (vec.length !== expectedDim) {
        throw new EmbeddingDimMismatchError(actualProvider, actualModel, expectedDim, vec.length);
      }
      results[missIndices[j]] = vec;
    }

    // Cache write (fire-and-forget).
    if (!EMBEDDING_CACHE_DISABLED) {
      const values: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (let j = 0; j < missIndices.length; j++) {
        values.push(`($${i++}, $${i++}, $${i++}::vector, 0)`);
        params.push(missHashes[j], actualModel, JSON.stringify(response.embeddings[j]));
      }
      pool.query(
        `INSERT INTO embedding_cache (content_hash, embedding_model, embedding, hit_count)
         VALUES ${values.join(', ')}
         ON CONFLICT (content_hash, embedding_model) DO NOTHING`,
        params,
      ).catch(err => log.warn({ err: err.message }, 'embedding cache batch write failed (non-fatal)'));
    }
  }

  return {
    embeddings: results as number[][],
    model: actualModel,
    provider: actualProvider,
    dim: dimensions,
  };
}

export async function generateEmbeddingsBatch(
  texts: string[],
  options?: GenerateEmbeddingOptions,
): Promise<number[][]> {
  return (await embedBatchInternal(texts, options)).embeddings;
}

export async function generateEmbeddingsBatchDetailed(
  texts: string[],
  options?: GenerateEmbeddingOptions,
): Promise<EmbeddingBatchResult> {
  return embedBatchInternal(texts, options);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Embedding dimensions must match');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
