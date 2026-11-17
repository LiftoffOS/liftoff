// The role layer is per (tenant, role), on every path that reads it.
//
// Before this, a role read had no scope at all: writes were keyed by the
// agent id, reads applied no role filter, so a Competitive Intelligence
// Analyst asking for "role" memories got every role row in the tenant,
// whoever's role wrote it. The vector and BM25 arms, the recency fallback they
// degrade to when embeddings fail, the peer window and the alias decoder each
// built their own WHERE clause; the tests below drive each path and assert the
// same policy on all of them, keyed by SQL content rather than call order.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    pool: { query, connect: jest.fn() },
    __query: query,
    getPoolForService: jest.fn(() => ({ query })),
  };
});

const mockGenerateEmbedding = jest.fn();
jest.mock('../hyde', () => ({
  generateHypotheticalDocument: jest.fn().mockResolvedValue('hyde-doc'),
}));
jest.mock('../embedding', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));

import { memoryService } from '../service';
import * as db from '../../infrastructure/database';

const ROLE = 'competitive-intelligence-analyst';
const query = (db as any).__query as jest.Mock;

type Call = [string, unknown[] | undefined];

/** Answer by what the SQL asks for, so the assertions do not depend on the
 *  order the service happens to issue its queries in. */
function answerByShape(opts: { strategy?: string; role?: string | null } = {}) {
  query.mockImplementation(async (sql: string) => {
    if (typeof sql !== 'string') return { rows: [], rowCount: 0 };
    if (sql.includes('FROM agents WHERE id')) {
      return { rows: opts.role === undefined ? [{ role: 'Competitive Intelligence Analyst' }] : (opts.role === null ? [] : [{ role: opts.role }]), rowCount: 1 };
    }
    if (sql.includes('memory_layer_strategy')) {
      return { rows: [{ memory_layer_strategy: opts.strategy ?? 'all' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function calls(): Call[] {
  return query.mock.calls.map((c: unknown[]) => [c[0] as string, c[1] as unknown[] | undefined]);
}
function callsMatching(fragment: string): Call[] {
  return calls().filter(([sql]) => typeof sql === 'string' && sql.includes(fragment));
}
/** The parameter bound to the role clause: the array param following the
 *  `<alias>.scope_key = ANY($n)` placeholder in this SQL. */
function roleKeysBound(call: Call): unknown {
  const m = /scope_key = ANY\(\$(\d+)\)/.exec(call[0]);
  if (!m) return undefined;
  return call[1]?.[Number(m[1]) - 1];
}

beforeEach(() => {
  query.mockReset();
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  // The role memo is per process; keep each case's lookup honest.
  (memoryService.constructor as unknown as { roleCache: Map<string, unknown> }).roleCache?.clear?.();
});

describe('role-layer scope on the semantic arms', () => {
  it('scopes role rows to the agent\'s own role on both the vector and BM25 queries', async () => {
    answerByShape();
    await memoryService.retrieveMemories({ tenantId: 't1', agentId: 'a1', query: 'pricing', layers: ['global', 'role'] });

    const vector = callsMatching('memories.embedding <=>');
    const bm25 = callsMatching('websearch_to_tsquery');
    expect(vector).toHaveLength(1);
    expect(bm25).toHaveLength(1);
    for (const call of [...vector, ...bm25]) {
      expect(call[0]).toContain("(memories.layer <> 'role' OR memories.scope_key = ANY(");
      expect(roleKeysBound(call)).toEqual([ROLE]);
    }
    // The old flat filter, which applied a caller's keys to every layer, is gone.
    for (const call of [...vector, ...bm25]) {
      expect(call[0]).not.toMatch(/AND scope_key = ANY/);
    }
  });

  it('an explicit scope_key narrows the role layer and nothing else', async () => {
    answerByShape();
    await memoryService.retrieveMemories({
      tenantId: 't1', agentId: 'a1', query: 'q', layers: ['global', 'role'], scopeKeys: ['Sales Engineer'],
    });
    const vector = callsMatching('memories.embedding <=>');
    expect(roleKeysBound(vector[0])).toEqual(['Sales Engineer']);
    // The role lookup is not even made: the caller said which role.
    expect(callsMatching('FROM agents WHERE id')).toHaveLength(0);
  });

  it('with no agent and no explicit key, the role layer is unreadable rather than tenant-wide', async () => {
    answerByShape();
    await memoryService.retrieveMemories({ tenantId: 't1', query: 'q', layers: ['global', 'role'] });
    const vector = callsMatching('memories.embedding <=>');
    expect(roleKeysBound(vector[0])).toEqual([]);
  });

  it('an agent with no recorded role sees no role rows', async () => {
    answerByShape({ role: null });
    await memoryService.retrieveMemories({ tenantId: 't1', agentId: 'a1', query: 'q', layers: ['role'] });
    const vector = callsMatching('memories.embedding <=>');
    expect(roleKeysBound(vector[0])).toEqual([]);
  });
});

describe('role-layer scope on the paths the semantic arms degrade to', () => {
  it('the recency fallback taken when the embedding provider throws applies the same policy', async () => {
    answerByShape();
    mockGenerateEmbedding.mockRejectedValue(new Error('embedding provider down'));
    await memoryService.retrieveMemories({ tenantId: 't1', agentId: 'a1', query: 'q', layers: ['global', 'role'] });

    const recency = callsMatching('ORDER BY m.created_at DESC LIMIT');
    expect(recency).toHaveLength(1);
    expect(recency[0][0]).toContain("(m.layer <> 'role' OR m.scope_key = ANY(");
    expect(roleKeysBound(recency[0])).toEqual([ROLE]);
    expect(callsMatching('memories.embedding <=>')).toHaveLength(0);
  });

  it('the recency path taken when the caller reports the provider unavailable applies it too', async () => {
    answerByShape();
    await memoryService.retrieveMemories({
      tenantId: 't1', agentId: 'a1', query: 'q', layers: ['global', 'role'], semanticRetrievalUnavailable: true,
    });
    const recency = callsMatching('ORDER BY m.created_at DESC LIMIT');
    expect(recency).toHaveLength(1);
    expect(roleKeysBound(recency[0])).toEqual([ROLE]);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('the peer window pulls global rows from anyone and role rows from this role only', async () => {
    answerByShape({ strategy: 'narrow_with_peer' });
    await memoryService.retrieveMemories({ tenantId: 't1', agentId: 'a1', query: 'q' });

    const peer = callsMatching("m.layer IN ('role', 'global')");
    expect(peer).toHaveLength(1);
    expect(peer[0][0]).toContain("(m.layer <> 'role' OR m.scope_key = ANY($4))");
    expect(peer[0][1]?.[3]).toEqual([ROLE]);
  });

  it('the alias decoder reads role glossary rows from this role only', async () => {
    answerByShape();
    await memoryService.retrieveMemories({ tenantId: 't1', agentId: 'a1', query: 'q' });

    const alias = callsMatching("tags && ARRAY['type:alias']");
    expect(alias).toHaveLength(1);
    expect(alias[0][0]).toContain("(layer <> 'role' OR scope_key = ANY($3))");
    expect(alias[0][1]?.[2]).toEqual([ROLE]);
  });
});

describe('resolveRoleScopeKey', () => {
  it('is the agent\'s role as a scope key (the column allows [a-zA-Z0-9_-] only), or null', async () => {
    answerByShape({ role: '  Code Reviewer ' });
    await expect(memoryService.resolveRoleScopeKey('t1', 'a1')).resolves.toBe('code-reviewer');
    answerByShape({ role: null });
    (memoryService.constructor as unknown as { roleCache: Map<string, unknown> }).roleCache.clear();
    await expect(memoryService.resolveRoleScopeKey('t1', 'a1')).resolves.toBeNull();
  });
});

describe('roleScopeKey', () => {
  it('maps a free-text role to the one key the column accepts', async () => {
    const { roleScopeKey } = await import('../service');
    expect(roleScopeKey('Competitive Intelligence Analyst')).toBe('competitive-intelligence-analyst');
    expect(roleScopeKey('  Code Reviewer ')).toBe('code-reviewer');
    expect(roleScopeKey('Sales / Engineer (EMEA)')).toBe('sales-engineer-emea');
    expect(roleScopeKey('---')).toBeNull();
    expect(roleScopeKey(null)).toBeNull();
    expect(roleScopeKey('competitive-intelligence-analyst')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
