// distill-cache unit tests
//
// Covers: computeCatalogHash, computeFingerprint, getCachedDistillation,
// setCachedDistillation — fingerprint stability, ordering independence, TTL
// expiry, DB error resilience, and upsert wiring.

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  computeCatalogHash,
  computeFingerprint,
  getCachedDistillation,
  setCachedDistillation,
} from '../distill-cache';
import { pool } from '../../infrastructure/database';
import type { DistillInput, DistillOutput } from '../distill-service';

const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_INPUT: DistillInput = {
  tenantId: 'tenant-abc',
  role: 'Sales Analyst',
  responsibilities: 'Analyze CRM data and generate weekly reports.',
  integrations: [
    { id: 'int-b', name: 'HubSpot', type: 'hubspot', selectedObjects: ['Contact'] },
    { id: 'int-a', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Opportunity'] },
  ],
  additionalContext: 'Focus on Q2 pipeline.',
};

const CACHED_RESULT: DistillOutput = {
  agentType: 'agent',
  summary: 'Analyzes CRM data.',
  systemPrompt: 'You are a Sales Analyst.',
  userInstructions: 'Run the weekly report.',
  instructionsMd: '## Role\nSales Analyst.',
  triggerConfig: { type: 'manual', reasoning: 'On demand' },
  skills: [],
  capabilityTier: 'connector_only',
};

// ── computeCatalogHash ───────────────────────────────────────────────────────

describe('computeCatalogHash', () => {
  it('returns a stable hex string for the same catalog content', () => {
    const catalog = new Map([
      ['tool_a', { name: 'tool_a', description: 'Does A' }],
      ['tool_b', { name: 'tool_b', description: 'Does B' }],
    ]);
    const h1 = computeCatalogHash(catalog);
    const h2 = computeCatalogHash(catalog);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it('is independent of Map insertion order', () => {
    const catalogAB = new Map([
      ['tool_a', { name: 'tool_a', description: 'Does A' }],
      ['tool_b', { name: 'tool_b', description: 'Does B' }],
    ]);
    const catalogBA = new Map([
      ['tool_b', { name: 'tool_b', description: 'Does B' }],
      ['tool_a', { name: 'tool_a', description: 'Does A' }],
    ]);
    expect(computeCatalogHash(catalogAB)).toBe(computeCatalogHash(catalogBA));
  });

  it('produces different hashes for different catalog content', () => {
    const c1 = new Map([['tool_a', { name: 'tool_a', description: 'v1' }]]);
    const c2 = new Map([['tool_a', { name: 'tool_a', description: 'v2 changed' }]]);
    expect(computeCatalogHash(c1)).not.toBe(computeCatalogHash(c2));
  });

  it('handles an empty catalog', () => {
    const hash = computeCatalogHash(new Map());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── computeFingerprint ───────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('returns a stable hex string for the same input', () => {
    const fp1 = computeFingerprint(BASE_INPUT, 'catalog-hash-abc', '');
    const fp2 = computeFingerprint(BASE_INPUT, 'catalog-hash-abc', '');
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2);
  });

  it('separates the two production strategies', () => {
    // Without this the A/B comparison measures nothing. Both arms replay the
    // same corpus, so on the second arm every input is byte-identical to the
    // first — it would hit this cache, return the OTHER arm's artifact in
    // milliseconds without an LLM call, and report a near-zero time with
    // perfect quality agreement. A total success, having measured nothing.
    const single = computeFingerprint({ ...BASE_INPUT, strategy: 'single' }, 'catalog-hash-abc', '');
    const waved = computeFingerprint({ ...BASE_INPUT, strategy: 'waved' }, 'catalog-hash-abc', '');
    expect(single).not.toBe(waved);
  });

  it('treats an absent strategy as single, so existing callers share one key', () => {
    const absent = computeFingerprint(BASE_INPUT, 'catalog-hash-abc', '');
    const explicit = computeFingerprint({ ...BASE_INPUT, strategy: 'single' }, 'catalog-hash-abc', '');
    expect(absent).toBe(explicit);
  });

  it('is independent of integration array order', () => {
    const reversed: DistillInput = {
      ...BASE_INPUT,
      integrations: [...BASE_INPUT.integrations!].reverse(),
    };
    expect(computeFingerprint(BASE_INPUT, 'cat-hash', ''))
      .toBe(computeFingerprint(reversed, 'cat-hash', ''));
  });

  it('produces a different fingerprint when role changes', () => {
    const other = { ...BASE_INPUT, role: 'Support Engineer' };
    expect(computeFingerprint(BASE_INPUT, 'cat-hash', ''))
      .not.toBe(computeFingerprint(other, 'cat-hash', ''));
  });

  it('produces a different fingerprint when tenantId changes', () => {
    const other = { ...BASE_INPUT, tenantId: 'tenant-xyz' };
    expect(computeFingerprint(BASE_INPUT, 'cat-hash', ''))
      .not.toBe(computeFingerprint(other, 'cat-hash', ''));
  });

  // The template's DECLARATIONS gate what a valid distillation must contain, and
  // they do it without changing one character of the prompt. So they have to be
  // in the key, or turning an obligation on leaves every agent already hired
  // from that template on the cached graph that does not satisfy it: the fence
  // that would add the step runs on the generation path, and a cache hit never
  // reaches it.
  it('separates two templates that differ only in a declared obligation', () => {
    // Real catalog entries: code-reviewer declares requiresIdempotencyCheck,
    // sprint-retrospective-lead declares nothing and fires by hand. Reading the
    // catalog rather than a fixture is deliberate: a fixture would keep passing
    // after someone changed what the templates declare.
    const a: DistillInput = { ...BASE_INPUT, templateId: 'code-reviewer' };
    const b: DistillInput = { ...BASE_INPUT, templateId: 'sprint-retrospective-lead' };
    expect(computeFingerprint(a, 'cat-hash')).not.toBe(computeFingerprint(b, 'cat-hash', ''));
  });

  it('separates a template-seeded hire from a free-text one', () => {
    const seeded: DistillInput = { ...BASE_INPUT, templateId: 'code-reviewer' };
    expect(computeFingerprint(seeded, 'cat-hash')).not.toBe(computeFingerprint(BASE_INPUT, 'cat-hash', ''));
  });

  it('stays stable for the same template', () => {
    const a: DistillInput = { ...BASE_INPUT, templateId: 'code-reviewer' };
    const b: DistillInput = { ...BASE_INPUT, templateId: 'code-reviewer' };
    expect(computeFingerprint(a, 'cat-hash', '')).toBe(computeFingerprint(b, 'cat-hash', ''));
  });

  it('does not throw on a template that has been withdrawn', () => {
    const gone: DistillInput = { ...BASE_INPUT, templateId: 'no-such-template-anywhere' };
    expect(() => computeFingerprint(gone, 'cat-hash', '')).not.toThrow();
  });

  it('produces a different fingerprint when catalogHash changes', () => {
    expect(computeFingerprint(BASE_INPUT, 'hash-v1', ''))
      .not.toBe(computeFingerprint(BASE_INPUT, 'hash-v2', ''));
  });

  it('trims whitespace from role and responsibilities before hashing', () => {
    const padded: DistillInput = {
      ...BASE_INPUT,
      role: '  Sales Analyst  ',
      responsibilities: '  Analyze CRM data and generate weekly reports.  ',
    };
    expect(computeFingerprint(BASE_INPUT, 'cat-hash', ''))
      .toBe(computeFingerprint(padded, 'cat-hash', ''));
  });
});

// ── getCachedDistillation ────────────────────────────────────────────────────

describe('getCachedDistillation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns null on a cache miss (no row)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const result = await getCachedDistillation('fp-abc');
    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('SELECT');
  });

  it('returns the cached DistillOutput on a valid hit', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    mockQuery.mockResolvedValueOnce({
      rows: [{ result: CACHED_RESULT, expires_at: expiresAt }],
    } as any);

    const result = await getCachedDistillation('fp-abc');
    expect(result).toEqual(CACHED_RESULT);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns null and issues a DELETE when the row is expired', async () => {
    const expiredAt = new Date(Date.now() - 1000); // 1 second in the past
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ result: CACHED_RESULT, expires_at: expiredAt }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any); // DELETE cleanup

    const result = await getCachedDistillation('fp-abc');
    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain('DELETE');
  });

  it('returns null (not throws) when the DB read fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const result = await getCachedDistillation('fp-abc');
    expect(result).toBeNull();
  });
});

// ── setCachedDistillation ────────────────────────────────────────────────────

describe('setCachedDistillation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('executes an INSERT ... ON CONFLICT DO UPDATE with correct params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    await setCachedDistillation('fp-xyz', 'tenant-abc', CACHED_RESULT);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO distillation_cache');
    expect(sql).toContain('ON CONFLICT');
    expect(params[0]).toBe('fp-xyz');
    expect(params[1]).toBe('tenant-abc');
    // params[2] is the JSON-serialized result
    expect(JSON.parse(params[2] as string)).toEqual(CACHED_RESULT);
    // params[3] is the expiry Date
    expect(params[3]).toBeInstanceOf(Date);
    expect((params[3] as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not throw when the DB write fails (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      setCachedDistillation('fp-xyz', 'tenant-abc', CACHED_RESULT),
    ).resolves.toBeUndefined();
  });
});
