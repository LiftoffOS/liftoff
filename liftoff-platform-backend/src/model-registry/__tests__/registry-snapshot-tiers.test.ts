// The registry snapshot carries the tier→model map, keyed the way the runtime
// dispatches.
//
// WHY THIS FEED EXISTS. A tenant's routing policy used to store a RESOLVED model
// id, and the runtime preferred it. That id is derivable from (provider, tier),
// so it was a cache with no invalidation: a tier move reached existing tenants
// only when a restamp job rewrote every policy on the next deploy, and when the
// OpenAI ladder moved to GPT-6 every existing workspace stayed a generation
// behind. Removing the stored id is the fix — but the runtime could not answer
// "(provider, tier) → model" from this snapshot at all, so removing it first
// would have dropped every run onto the runtime's own hard-coded tier maps,
// which is how its `medium` came to sit a generation behind this plane's.
//
// `branding` is not a substitute and cannot be made into one: a codename is the
// tier's REDACTION label, it is many-to-one (fourteen ids map to `hyperion`),
// and the row carries no provider. A routing fact has to travel as a routing
// fact.
//
// The provider key is the whole safety property. The runtime resolves a tier
// under the provider it DISPATCHES on, so a feed keyed the registry's vendor way
// would miss for exactly the vendors whose keys differ — silently, leaving them
// on the static seed, which is the failure this feed exists to end.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { modelRegistryInternalRouter } from '../model-registry-internal-router';

const app = express();
app.use('/api/internal/model-registry', modelRegistryInternalRouter);

interface TierRow { provider: string; tier: string; model_id: string }

/** Answers the handler's queries in order — pricing, branding, windows, tiers —
 *  with a trailing catch-all for the platform-vendor read that follows. */
function respondWithTiers(tierRows: TierRow[]) {
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [] } as never)   // pricing
    .mockResolvedValueOnce({ rows: [] } as never)   // branding
    .mockResolvedValueOnce({ rows: [] } as never)   // windows
    .mockResolvedValueOnce({ rows: [] } as never)   // request surfaces
    .mockResolvedValueOnce({ rows: tierRows } as never)
    .mockResolvedValue({ rows: [] } as never);      // platform vendors
}

async function tiersFor(rows: TierRow[]): Promise<TierRow[]> {
  respondWithTiers(rows);
  const res = await request(app).get('/api/internal/model-registry');
  expect(res.status).toBe(200);
  return (res.body as { tiers: TierRow[] }).tiers;
}

describe('registry snapshot: the tier→model feed', () => {
  it('serves a tier row per provider and tier', async () => {
    const tiers = await tiersFor([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-5-5' },
      { provider: 'anthropic', tier: 'large', model_id: 'claude-opus-5-5' },
      { provider: 'openai', tier: 'medium', model_id: 'gpt-6-sol' },
    ]);

    expect(tiers).toEqual([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-5-5' },
      { provider: 'anthropic', tier: 'large', model_id: 'claude-opus-5-5' },
      { provider: 'openai', tier: 'medium', model_id: 'gpt-6-sol' },
    ]);
  });

  it('keys each family under the provider it EXECUTES on, not its registry key', async () => {
    // 'grok' is the model line; 'xai' is what serves it. A runtime resolving a
    // tier asks under 'xai', so a row left under 'grok' would never be found and
    // that vendor alone would keep answering from its static seed.
    const tiers = await tiersFor([
      { provider: 'grok', tier: 'large', model_id: 'grok-4.6' },
    ]);

    expect(tiers).toEqual([{ provider: 'xai', tier: 'large', model_id: 'grok-4.6' }]);
  });

  it('passes through a provider key that names no vendor', async () => {
    // A row from a restored backup or a script not yet updated still travels,
    // rather than being dropped on the floor where nobody would notice it.
    const tiers = await tiersFor([
      { provider: 'some-new-vendor', tier: 'small', model_id: 'nv-1-mini' },
    ]);

    expect(tiers).toEqual([
      { provider: 'some-new-vendor', tier: 'small', model_id: 'nv-1-mini' },
    ]);
  });

  it('asks for the NEWEST approved model per provider and tier', async () => {
    // The same selection registry-tier-loader and workspace-ai-vendor-loader
    // make, so all three answer identically by construction rather than by
    // three people remembering to keep them aligned. Asserted on the SQL because
    // that is where the property lives: a query without DISTINCT ON would serve
    // several models for one tier and the runtime would take whichever arrived
    // last.
    await tiersFor([]);

    const sql = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .find((q) => q.includes('DISTINCT ON (provider, tier)'));

    expect(sql).toBeDefined();
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('tier IS NOT NULL');
    expect(sql).toContain('ORDER BY provider, tier, created_at DESC');
  });

  it('serves tiers alongside every other overlay, not instead of one', async () => {
    // The runtime installs all five from one response. A feed that replaced
    // another would leave that overlay empty and the consumer on its seed.
    respondWithTiers([{ provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-5-5' }]);
    const res = await request(app).get('/api/internal/model-registry');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body as Record<string, unknown>).sort())
      .toEqual(['branding', 'platformVendors', 'pricing', 'surfaces', 'tiers', 'windows']);
  });
});
