// Rollup tests — pure aggregation + the DB-driven runTrustRollup against a
// fake pool that returns seeded `actions` / `hitl_approval_requests` rows.

import {
  aggregateTrust,
  runTrustRollup,
  type ActionCountRow,
  type RejectRow,
} from '../../jobs/trust-rollup/rollup-trust';

describe('aggregateTrust', () => {
  it('folds completed→pass, failed→reject and computes runs/tier per class', () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'salesforce__update', status: 'completed', n: 22, last_at: '2026-07-10T00:00:00Z' },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'salesforce__update', status: 'failed', n: 1, last_at: '2026-07-11T00:00:00Z' },
    ];
    const out = aggregateTrust(actions, []);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row).toMatchObject({
      tenantId: 't1',
      agentId: 'a1',
      actionClass: 'update',
      passes: 22,
      rejects: 1,
      runs: 23,
      tier: 'auto', // 23 runs, 22/23 ≈ 0.957 ≥ PROMOTE
    });
    expect(row.lastOutcomeAt?.toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });

  it('collapses dispatch-prefixed tool names to the same action_class', () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'mcp__liftoff-tools-xyz__gmail__send', status: 'completed', n: 3, last_at: null },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'gmail__send', status: 'completed', n: 2, last_at: null },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'send', status: 'failed', n: 1, last_at: null },
    ];
    const out = aggregateTrust(actions, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actionClass: 'send', passes: 5, rejects: 1, runs: 6 });
  });

  it('counts one reject per rejected tool call, keyed by normalized class', () => {
    const rejects: RejectRow[] = [
      {
        tenant_id: 't1',
        agent_id: 'a1',
        decided_at: '2026-07-12T00:00:00Z',
        pending_tool_calls: [
          { id: 'x', name: 'salesforce__delete', input: {} },
          { id: 'y', name: 'mcp__srv__delete', input: {} },
        ],
      },
    ];
    const out = aggregateTrust([], rejects);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actionClass: 'delete', passes: 0, rejects: 2, runs: 2, tier: 'watch' });
  });

  it('accepts pending_tool_calls as a JSON string (JSONB round-trip)', () => {
    const rejects: RejectRow[] = [
      {
        tenant_id: 't1',
        agent_id: 'a1',
        decided_at: null,
        pending_tool_calls: JSON.stringify([{ id: 'x', name: 'db__drop', input: {} }]),
      },
    ];
    const out = aggregateTrust([], rejects);
    expect(out[0]).toMatchObject({ actionClass: 'drop', rejects: 1 });
  });

  it('merges action-failures and HITL rejections into one rejects count', () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'x__wire', status: 'completed', n: 10, last_at: null },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'x__wire', status: 'failed', n: 2, last_at: null },
    ];
    const rejects: RejectRow[] = [
      { tenant_id: 't1', agent_id: 'a1', decided_at: null, pending_tool_calls: [{ id: 'z', name: 'wire', input: {} }] },
    ];
    const out = aggregateTrust(actions, rejects);
    expect(out[0]).toMatchObject({ passes: 10, rejects: 3, runs: 13 });
  });

  it('keeps distinct (tenant, agent, class) keys separate', () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'a__x', status: 'completed', n: 1, last_at: null },
      { tenant_id: 't2', agent_id: 'a1', tool_name: 'a__x', status: 'completed', n: 1, last_at: null },
      { tenant_id: 't1', agent_id: 'a2', tool_name: 'a__x', status: 'completed', n: 1, last_at: null },
    ];
    const out = aggregateTrust(actions, []);
    expect(out).toHaveLength(3);
  });

  it('ignores rows with missing agent/tenant/class or non-terminal status', () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: '', tool_name: 'a__x', status: 'completed', n: 5, last_at: null },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'a__x', status: 'pending', n: 5, last_at: null },
      { tenant_id: 't1', agent_id: 'a1', tool_name: '', status: 'completed', n: 5, last_at: null },
    ];
    expect(aggregateTrust(actions, [])).toHaveLength(0);
  });
});

describe('runTrustRollup', () => {
  function fakePool(actions: ActionCountRow[], rejects: RejectRow[]) {
    const upserts: unknown[][] = [];
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM actions')) return { rows: actions, rowCount: actions.length };
      if (sql.includes('FROM hitl_approval_requests')) return { rows: rejects, rowCount: rejects.length };
      if (sql.includes('INSERT INTO agent_action_trust')) {
        upserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { pool: { query } as any, upserts, query };
  }

  it('reads both sources, upserts one row per key, and tallies tiers', async () => {
    const actions: ActionCountRow[] = [
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'sf__update', status: 'completed', n: 25, last_at: '2026-07-14T00:00:00Z' },
      { tenant_id: 't1', agent_id: 'a1', tool_name: 'sf__update', status: 'failed', n: 1, last_at: null },
      { tenant_id: 't2', agent_id: 'a9', tool_name: 'sf__delete', status: 'failed', n: 4, last_at: null },
    ];
    const rejects: RejectRow[] = [
      { tenant_id: 't2', agent_id: 'a9', decided_at: null, pending_tool_calls: [{ id: 'q', name: 'sf__delete', input: {} }] },
    ];
    const { pool, upserts } = fakePool(actions, rejects);

    const summary = await runTrustRollup(pool, { windowDays: 30, logger: () => undefined });

    expect(summary.keysUpserted).toBe(2);
    expect(upserts).toHaveLength(2);
    // t1/a1/update: 25 pass, 1 reject → auto. t2/a9/delete: 0 pass, 5 reject → watch.
    expect(summary.tierCounts.auto).toBe(1);
    expect(summary.tierCounts.watch).toBe(1);

    // Upsert params shape: [tenant, agent, class, runs, passes, rejects, tier, lastOutcomeAt]
    const autoRow = upserts.find((p) => p[6] === 'auto')!;
    expect(autoRow.slice(0, 7)).toEqual(['t1', 'a1', 'update', 26, 25, 1, 'auto']);

    const watchRow = upserts.find((p) => p[6] === 'watch')!;
    expect(watchRow.slice(0, 7)).toEqual(['t2', 'a9', 'delete', 5, 0, 5, 'watch']);
  });

  it('passes the window through to both queries', async () => {
    const { pool, query } = fakePool([], []);
    await runTrustRollup(pool, { windowDays: 7, logger: () => undefined });
    const calls = query.mock.calls.filter(
      (c) => String(c[0]).includes('FROM actions') || String(c[0]).includes('FROM hitl_approval_requests'),
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c[1]).toEqual([7]);
  });
});
