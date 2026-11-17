// P1.3 — proposal lifecycle.
//
// Two behaviours here are load-bearing and both are about what happens the
// SECOND time something runs:
//
//  * Accepting appends prose to standing guidance and redistills. That is slow
//    enough for a Cloud Tasks retry to land in the middle, so the proposal must
//    be CLAIMED before the work, not marked afterwards — otherwise the retry
//    appends the same routine again.
//  * A declined idea is latched forever. A "later" is not: once its cooldown
//    expires the same idea may be offered once more, or the cooldown column is
//    written and never read and "ask me later" quietly means "never".

import { claimForAcceptance, createSuggestion, getOpenSuggestion, markDecided, releaseClaim } from '../suggestion-service';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('claimForAcceptance', () => {
  it('only takes a proposal that is still pending', async () => {
    query.mockResolvedValue({ rows: [{ id: 's1' }], rowCount: 1 });
    await claimForAcceptance(TENANT, 's1');

    const [sql] = query.mock.calls[0];
    // Conditional on the status, so two workers cannot both win it.
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'pending'/);
    expect(sql).toMatch(/SET status = 'accepted'/);
  });

  it('reports success when it won the claim', async () => {
    query.mockResolvedValue({ rows: [{ id: 's1' }], rowCount: 1 });
    await expect(claimForAcceptance(TENANT, 's1')).resolves.toBe(true);
  });

  it('reports failure when someone else already had it', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(claimForAcceptance(TENANT, 's1')).resolves.toBe(false);
  });
});

describe('releaseClaim', () => {
  it('hands back only a proposal this flow had claimed', async () => {
    await releaseClaim(TENANT, 's1');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'pending'/);
    // Never resurrects one the person actually declined.
    expect(sql).toMatch(/AND status = 'accepted'/);
  });
});

describe('createSuggestion', () => {
  /** No open proposal, and the insert reports what the conflict clause did. */
  function primeInsert(inserted: boolean) {
    query.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM agent_suggestions/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO agent_suggestions/.test(sql)) {
        return inserted
          ? { rows: [{ id: 's1', tenant_id: TENANT, agent_id: AGENT, dedup_key: 'k', source: 'chat', proposal_text: 'p', routine_prose: 'r', provenance_note: null, status: 'pending', thread_id: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  const params = {
    tenantId: TENANT, agentId: AGENT, dedupKey: 'k',
    source: 'chat' as const, proposalText: 'p', routineProse: 'r',
  };

  it('re-opens an idea whose cooldown has expired', async () => {
    primeInsert(true);
    await createSuggestion(params);

    const insert = query.mock.calls.find(([sql]) => /INSERT INTO agent_suggestions/.test(sql as string));
    const sql = insert![0] as string;
    expect(sql).toMatch(/ON CONFLICT \(agent_id, dedup_key\) DO UPDATE/);
    expect(sql).toMatch(/agent_suggestions\.status = 'cooldown'/);
    expect(sql).toMatch(/cooldown_until <= NOW\(\)/);
  });

  it('clears the previous decision when it re-opens one', async () => {
    primeInsert(true);
    await createSuggestion(params);
    const sql = query.mock.calls.find(([s]) => /INSERT INTO agent_suggestions/.test(s as string))![0] as string;
    // A re-offered proposal must not carry the old thread or decision with it.
    expect(sql).toMatch(/decided_at = NULL/);
    expect(sql).toMatch(/cooldown_until = NULL/);
    expect(sql).toMatch(/thread_id = NULL/);
  });

  it('stays silent when the idea is latched or still cooling', async () => {
    primeInsert(false);
    await expect(createSuggestion(params)).resolves.toBeNull();
  });

  it('never offers a second proposal while one is open', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM agent_suggestions/.test(sql)) {
        return { rows: [{ id: 'open', tenant_id: TENANT, agent_id: AGENT, dedup_key: 'other', source: 'chat', proposal_text: 'p', routine_prose: 'r', provenance_note: null, status: 'pending', thread_id: 't' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(createSuggestion(params)).resolves.toBeNull();
    expect(query.mock.calls.some(([s]) => /INSERT INTO agent_suggestions/.test(s as string))).toBe(false);
  });
});

describe('getOpenSuggestion', () => {
  it('asks only for pending proposals', async () => {
    await getOpenSuggestion(TENANT, AGENT);
    expect(query.mock.calls[0][0]).toMatch(/status = 'pending'/);
  });
});

describe('markDecided', () => {
  it('sets a cooldown deadline for "later", and none for the others', async () => {
    await markDecided(TENANT, 's1', 'cooldown');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/cooldown_until = CASE WHEN \$1 = 'cooldown'/);
    expect(params).toContain('cooldown');
  });
});
