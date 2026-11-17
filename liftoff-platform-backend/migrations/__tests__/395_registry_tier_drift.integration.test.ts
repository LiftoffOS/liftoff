// Migration 395 — the registry and the code constants give the SAME answer.
//
// Model names used to live in three places: the `models` registry, each
// provider's static TIER_MODELS/DEFAULT_MODEL, and the Workspace AI vendor map.
// Nothing kept them in step and they drifted, which is not a cosmetic problem:
// two Gemini ids in the provider map did not exist at Vertex at all, so every
// tier-only Google request on large and medium returned 404.
//
// The registry is now the source — the loaders overlay it onto the other two —
// but an overlay only covers what the registry HAS, and it covers it only after
// the first load lands. So two things are asserted, and they are different
// questions:
//
//   1. REGISTERED. Every id reachable from any path has an approved row. An id
//      with no row cannot be tier-resolved from the registry, cannot be priced
//      by the sync job, and answers "cannot see" at the vision gate.
//   2. AGREES. Every id a TIER resolves to is the id the registry resolves for
//      that tier. A seed that is registered but stale still gives two answers
//      for one tier — the seed's before the first load and on a failed refresh,
//      the registry's after — which is the drift itself, one step further in.
//   3. IS SIZED. Every reachable, non-retired, non-embedding model a MIGRATION
//      is responsible for carries a `context_window`. A NULL there is not
//      inert: every consumer falls back to a conservative 128,000, so a 1M
//      model closes its turns at ~90,000 — nine per cent of the window the
//      workspace is paying for — and nothing reports it. Eight rows sat that
//      way until migration 522, seven of them approved and reachable, and this
//      assertion found three more on its first run (the xAI rows migration 523
//      records: migration 380 left them NULL expecting the pricing sync to
//      size them, and xAI's transport later became 'direct', which the sync
//      does not read). This is the only check that can see any of it, because
//      it is the only one with a migrated database in front of it.
//
// Registration is asserted for every reachable id; agreement only where the
// registry has an answer, because a tier the registry does not carry (DeepSeek
// and Moonshot register no small row) legitimately keeps its seed.
//
// SIZING is narrower than the other two, and each exclusion is a fact rather
// than an allowance:
//
//   * an EMBEDDING model has no turn and therefore no turn context window.
//     Filling one would destroy the meaning of NULL in that column.
//   * an OPENROUTER-HOSTED model is sized at RUN TIME, from the gateway's
//     endpoints API, by the model-pricing-sync job (migration 343 states this,
//     and sync-model-pricing.ts does it). This suite runs against a FRESHLY
//     migrated database, where that job has never run, so a NULL there is
//     expected rather than missing. Derived from `OPENROUTER_HOSTED_PROVIDERS`
//     rather than listed, so a vendor moved off the gateway is caught on the
//     edit that moves it.
//
// What is left is exactly the set a migration is responsible for, and the
// assertion over it is UNCONDITIONAL: there is no baseline and no allow-list,
// because an unsized model is not debt that can be carried. It degrades
// silently — the runtime falls back to a family floor, keeps logging ratios,
// and simply stops being allowed to retire a session — so a frozen set would
// be a place a real defect goes to be forgotten, which is exactly how the
// three xAI rows migration 523 records came to sit unsized for months.
//
// Runs in CI against the migration gate's freshly migrated database — see
// scripts/ci/check-registry-drift.sh, called from cloudbuild.yaml and
// .husky/pre-push. To run it by hand:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/395_registry_tier_drift.integration.test.ts

import { Pool, PoolClient } from 'pg';
import {
  TIER_MODELS as ANTHROPIC_TIER_MODELS,
  DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL,
} from '../../src/llm/providers/anthropic';
import {
  TIER_MODELS as GOOGLE_TIER_MODELS,
  DEFAULT_MODEL as GOOGLE_DEFAULT_MODEL,
} from '../../src/llm/providers/google';
import {
  TIER_MODELS as OPENAI_TIER_MODELS,
  DEFAULT_MODEL as OPENAI_DEFAULT_MODEL,
} from '../../src/llm/providers/openai';
import { OPENROUTER_TIER_MODELS } from '../../src/llm/providers/openrouter';
import {
  EMBEDDING_DEFAULTS,
  OPENROUTER_HOSTED_PROVIDERS,
  WORKSPACE_AI_VENDORS,
  type WorkspaceAiTier,
  type WorkspaceAiVendor,
} from '../../src/model-registry/workspace-ai-vendors';

/** One model id a request can reach, and where the registry keeps its row.
 *
 *  `registryProvider` is the `models.provider` value, which is NOT always the
 *  runtime provider: the Anthropic Vertex provider routes to rows under
 *  'anthropic', and the OpenRouter-served vendors carry their own keys while
 *  executing under 'openrouter'. Every entry names exactly one key, so a row
 *  filed under the wrong one is a failure rather than a shrug. */
interface Reachable {
  /** Where a reader should go to fix it. */
  source: string;
  modelId: string;
  registryProvider: string;
  /** Set when this id is what a TIER resolves to, so the registry's answer for
   *  that (provider, tier) must equal it. Absent for DEFAULT_MODEL and for the
   *  embedding override, which are not tier entries. */
  tier?: WorkspaceAiTier;
}

function fromTierMap(
  source: string,
  tiers: Record<string, string>,
  registryProvider: string,
): Reachable[] {
  return Object.entries(tiers).map(([tier, modelId]) => ({
    source: `${source}.${tier}`,
    modelId,
    registryProvider,
    tier: tier as WorkspaceAiTier,
  }));
}

function reachableModelIds(): Reachable[] {
  const out: Reachable[] = [
    // Each provider's static seed. This is what resolves before the registry
    // overlay lands and what keeps resolving when a refresh fails, so a stale
    // seed is reachable in production, not merely in theory.
    ...fromTierMap('providers/anthropic TIER_MODELS', ANTHROPIC_TIER_MODELS, 'anthropic'),
    {
      source: 'providers/anthropic DEFAULT_MODEL',
      modelId: ANTHROPIC_DEFAULT_MODEL,
      registryProvider: 'anthropic',
    },
    ...fromTierMap('providers/google TIER_MODELS', GOOGLE_TIER_MODELS, 'google'),
    {
      source: 'providers/google DEFAULT_MODEL',
      modelId: GOOGLE_DEFAULT_MODEL,
      registryProvider: 'google',
    },
    ...fromTierMap('providers/openai TIER_MODELS', OPENAI_TIER_MODELS, 'openai'),
    {
      source: 'providers/openai DEFAULT_MODEL',
      modelId: OPENAI_DEFAULT_MODEL,
      registryProvider: 'openai',
    },
    // The platform's own gateway client has no DEFAULT_MODEL of its own — it
    // inherits OpenAI's, which is checked above under the provider that owns
    // it. Its tier map is GLM's and reads rows under 'glm' alone, which is what
    // keeps the other three gateway-served families from displacing it.
    ...fromTierMap(
      'providers/openrouter OPENROUTER_TIER_MODELS',
      OPENROUTER_TIER_MODELS,
      'glm',
    ),
    // Stamped into EVERY tenant's routing policy (migration 188) and reachable
    // on every retrieval, save and consolidation. It carries no tier, so only
    // registration applies.
    {
      source: 'WORKSPACE_AI_VENDORS EMBEDDING_DEFAULTS',
      modelId: EMBEDDING_DEFAULTS.model,
      registryProvider: EMBEDDING_DEFAULTS.provider,
    },
  ];

  // The Workspace AI vendor map: what a workspace gets stamped into its
  // model_configs row, and what a per-agent vendor override resolves through.
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    out.push(
      ...fromTierMap(
        `WORKSPACE_AI_VENDORS.${vendor}`,
        WORKSPACE_AI_VENDORS[vendor].tiers,
        // The registry key IS the execution provider after migration 450 —
        // one vocabulary, so there is no second map to read it from.
        WORKSPACE_AI_VENDORS[vendor].provider,
      ),
    );
    // The Frontier model: a designation, not a tier (migration 529), so
    // registration, provider and sizing apply and tier agreement does not.
    const frontier = WORKSPACE_AI_VENDORS[vendor].frontier;
    if (frontier) {
      out.push({
        source: `WORKSPACE_AI_VENDORS.${vendor}.frontier`,
        modelId: frontier,
        registryProvider: WORKSPACE_AI_VENDORS[vendor].provider,
      });
    }
  }
  return out;
}

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('the registry and the code constants agree (migration 395)', () => {
  let pool: Pool;
  let client: PoolClient;
  /** model_id → provider, for every approved row. */
  let approved: Map<string, string>;
  /** model_id → its recorded window and whether the row is an embedding
   *  model, for every approved row. */
  let sized: Map<string, { contextWindow: number | null; embedding: boolean }>;
  /** `${provider}|${tier}` → the newest approved model id, exactly as the
   *  loaders resolve it. */
  let newestPerTier: Map<string, string>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();

    // `status = 'approved'` is what "non-retired" means in this table: a
    // model taken out of service is 'disabled' (migrations 322, 380, 396) and
    // is deliberately not held to any of the three assertions.
    const rows = await client.query<{
      model_id: string; provider: string; context_window: number | null; capabilities: unknown;
    }>(
      `SELECT model_id, provider, context_window, capabilities
         FROM models WHERE status = 'approved'`,
    );
    approved = new Map(rows.rows.map((r) => [r.model_id, r.provider]));
    sized = new Map(rows.rows.map((r) => [r.model_id, {
      contextWindow: r.context_window,
      embedding: Array.isArray(r.capabilities) && r.capabilities.includes('embedding'),
    }]));

    // The same DISTINCT ON both loaders issue. Asserting against the query
    // rather than a hand-written expectation is the point: if the loaders'
    // resolution changes, this changes with it.
    const tiers = await client.query<{ provider: string; tier: string; model_id: string }>(
      `SELECT DISTINCT ON (provider, tier) provider, tier, model_id
         FROM models
        WHERE status = 'approved' AND tier IS NOT NULL
        ORDER BY provider, tier, created_at DESC`,
    );
    newestPerTier = new Map(
      tiers.rows.map((r) => [`${r.provider}|${r.tier}`, r.model_id]),
    );
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('has an approved row for every id a request can resolve to', () => {
    const missing = reachableModelIds()
      .filter((r) => !approved.has(r.modelId))
      .map((r) => `${r.source} → ${r.modelId}`);
    expect(missing).toEqual([]);
  });

  it('files each of them under the expected provider key', () => {
    const wrong = reachableModelIds()
      .filter((r) => approved.has(r.modelId))
      .filter((r) => approved.get(r.modelId) !== r.registryProvider)
      .map(
        (r) =>
          `${r.source} → ${r.modelId} is filed under '${approved.get(r.modelId)}', `
          + `expected '${r.registryProvider}'`,
      );
    expect(wrong).toEqual([]);
  });

  it('records a context window for every reachable model a migration is responsible for', () => {
    const unsized = reachableModelIds()
      // A row that is missing or retired is the other two tests' business;
      // this one would otherwise report the same defect a second time under a
      // name that sends the reader somewhere else.
      .filter((r) => sized.has(r.modelId))
      .filter((r) => !sized.get(r.modelId)!.embedding)
      // Sized by the sync from the gateway's endpoints API, not by a migration
      // — see the header.
      .filter((r) => !OPENROUTER_HOSTED_PROVIDERS.includes(r.registryProvider))
      .filter((r) => {
        const w = sized.get(r.modelId)!.contextWindow;
        return typeof w !== 'number' || w <= 0;
      })
      // De-duplicated BY ID: one model is commonly reachable from several
      // sources (a provider tier map and a Workspace AI vendor map), and one
      // unrecorded window is one defect however many paths reach it. The first
      // source is named so the reader has somewhere to start.
      .filter((r, i, all) => all.findIndex((o) => o.modelId === r.modelId) === i)
      .map((r) => `${r.modelId} (${r.registryProvider}) — reachable from ${r.source}`);
    expect(unsized).toEqual([]);
  });

  it('gives every tier the same answer the registry gives', () => {
    const disagreements = reachableModelIds()
      .filter((r): r is Reachable & { tier: WorkspaceAiTier } => r.tier !== undefined)
      // A tier the registry does not carry legitimately keeps its seed.
      .filter((r) => newestPerTier.has(`${r.registryProvider}|${r.tier}`))
      .filter((r) => newestPerTier.get(`${r.registryProvider}|${r.tier}`) !== r.modelId)
      .map(
        (r) =>
          `${r.source} seeds '${r.modelId}' but the registry resolves `
          + `${r.registryProvider}/${r.tier} to `
          + `'${newestPerTier.get(`${r.registryProvider}|${r.tier}`)}'`,
      );
    expect(disagreements).toEqual([]);
  });
});
