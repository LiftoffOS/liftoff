// A distill that misses the specs cache waits a bounded time for the LLM
// derivation rather than taking the keyword heuristic at once. The distills
// that build and correct a team run in the background and can afford it, and
// they are the ones that decide what the team is wired to; the heuristic
// names no platform, so prior art for "posts from a named site" was never
// found at the distill that mattered.

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: unknown) => unknown) => fn({ query: jest.fn() })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../distill-prior-art-injection', () => ({
  capabilitySpecsSourceHash: () => 'hash',
  deriveCapabilitySpecsLLM: jest.fn(),
}));

import { deriveCapabilitySpecsLLM } from '../distill-prior-art-injection';
import { deriveCapabilitySpecsWithin } from '../capability-specs-cache';

const spec = { mode: 'public_data', operation: 'search', entity: 'posts', targetSystem: 'reddit', availableInputs: [], requiredOutputFields: [], boundConnectorTypes: [], tenantId: 't1' };

beforeEach(() => jest.clearAllMocks());

describe('deriveCapabilitySpecsWithin', () => {
  it('returns the derived specs when they land within the wait, and caches them', async () => {
    (deriveCapabilitySpecsLLM as jest.Mock).mockResolvedValue([spec]);
    const out = await deriveCapabilitySpecsWithin(1_000, 'agent-1', 't1', 'Watcher', 'Pull posts from reddit', []);
    expect(out).toEqual([spec]);
  });

  it('returns null when the derivation outlasts the wait, leaving it to finish for the next distill', async () => {
    let finish!: (v: unknown) => void;
    (deriveCapabilitySpecsLLM as jest.Mock).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const out = await deriveCapabilitySpecsWithin(20, 'agent-1', 't1', 'Watcher', 'Pull posts', []);
    expect(out).toBeNull();
    finish([spec]);
  });

  it('derives directly for a first distill with no row to cache on', async () => {
    (deriveCapabilitySpecsLLM as jest.Mock).mockResolvedValue([spec]);
    const out = await deriveCapabilitySpecsWithin(1_000, null, 't1', 'Watcher', 'Pull posts', []);
    expect(out).toEqual([spec]);
  });

  it('returns null, never throws, when the derivation fails', async () => {
    (deriveCapabilitySpecsLLM as jest.Mock).mockRejectedValue(new Error('model down'));
    await expect(deriveCapabilitySpecsWithin(1_000, 'agent-1', 't1', 'W', 'R', [])).resolves.toBeNull();
    await expect(deriveCapabilitySpecsWithin(1_000, null, 't1', 'W', 'R', [])).resolves.toBeNull();
  });
});
