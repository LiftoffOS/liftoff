/**
 * Phase 2 PB-2 of the deep-research-realtime-billing plan.
 *
 * applyOuRefund credits a previously-debited OU consumption when a
 * deep_research delta event reports a negative cost (over-estimate
 * true-up) or a FAILED refund. It mirrors applyOuConsumption's locking +
 * dedup pattern but DEcrements ous_consumed_this_period instead of
 * incrementing.
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { PoolClient } from 'pg';
import {
  applyOuConsumption,
  applyOuRefund,
  _resetOuDefinitionRateCacheForTesting,
} from '../ou-bucket-service';

interface QueryStub { match: (sql: string) => boolean; result: { rows: unknown[]; rowCount?: number } }

function buildClient(stubs: QueryStub[]): PoolClient & { lastDecrementParams?: unknown[] } {
  let decrementParams: unknown[] | undefined;
  const query = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('UPDATE billing_controls') && sql.includes('GREATEST')) {
      decrementParams = params;
      return { rows: [], rowCount: 1 };
    }
    for (const s of stubs) {
      if (s.match(sql)) return s.result;
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    release: jest.fn(),
    get lastDecrementParams() { return decrementParams; },
  } as unknown as PoolClient & { lastDecrementParams?: unknown[] };
}

beforeEach(() => {
  _resetOuDefinitionRateCacheForTesting();
});

describe('applyOuRefund', () => {
  const ACCOUNT_ID = 'acct-1';

  // Stubs: billing_system_settings.ou_definition_rate_usd → 0.0001/OU
  // (the rate getOuDefinitionRateUsd actually reads — verified at
  // ou-bucket-service.ts:36); billing_controls FOR UPDATE → reload_rate
  // 0.0001/OU + 1000 already consumed. Matches the pricing shape
  // applyOuConsumption tests already use.
  function stdStubs(): QueryStub[] {
    return [
      {
        match: (s) => s.includes('billing_system_settings'),
        result: { rows: [{ value: '0.0001' }], rowCount: 1 },
      },
      {
        match: (s) => s.includes('FROM billing_controls') && s.includes('FOR UPDATE'),
        result: {
          rows: [{ ous_consumed_this_period: '1000', reload_rate_usd_per_ou: '0.0001' }],
          rowCount: 1,
        },
      },
    ];
  }

  it('returns null and does NOT touch the counter when refundCostUsd <= 0', async () => {
    const client = buildClient(stdStubs());
    const out = await applyOuRefund(client, ACCOUNT_ID, 0);
    expect(out).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('decrements ous_consumed_this_period and returns ouRefunded + customerCreditUsd', async () => {
    const client = buildClient(stdStubs());
    const out = await applyOuRefund(client, ACCOUNT_ID, 0.30);   // $0.30 refund
    expect(out).not.toBeNull();
    // $0.30 / $0.0001 = 3000 OU refunded.
    expect(out!.ouRefunded).toBeCloseTo(3000);
    // customerCreditUsd = ouToRefund * reloadRate = 3000 * 0.0001 = $0.30.
    expect(out!.customerCreditUsd).toBeCloseTo(0.30);
  });

  it('floors the counter at 0 (GREATEST(0, …)) to avoid negative ous_consumed', async () => {
    const client = buildClient(stdStubs());
    await applyOuRefund(client, ACCOUNT_ID, 0.30);
    const updateCalls = (client.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE billing_controls') && (c[0] as string).includes('GREATEST(0,'),
    );
    expect(updateCalls.length).toBe(1);
  });

  it('returns null when the account has no billing_controls row (unprovisioned)', async () => {
    const client = buildClient([
      // FOR UPDATE returns no rows
      { match: (s) => s.includes('FROM billing_controls'), result: { rows: [], rowCount: 0 } },
      // ou_definitions never queried because we early-return
      { match: (s) => s.includes('FROM ou_definitions'), result: { rows: [{ rate_usd_per_ou: '0.0001' }], rowCount: 1 } },
    ]);
    const out = await applyOuRefund(client, ACCOUNT_ID, 0.30);
    expect(out).toBeNull();
  });

  it('honors the isDuplicate callback and returns null without touching the counter', async () => {
    const client = buildClient(stdStubs());
    const isDuplicate = jest.fn().mockResolvedValue(true);
    const out = await applyOuRefund(client, ACCOUNT_ID, 0.30, { isDuplicate });
    expect(out).toBeNull();
    expect(isDuplicate).toHaveBeenCalledTimes(1);
    const updateCalls = (client.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('GREATEST'),
    );
    expect(updateCalls.length).toBe(0);
  });

  it('proceeds normally when isDuplicate returns false', async () => {
    const client = buildClient(stdStubs());
    const isDuplicate = jest.fn().mockResolvedValue(false);
    const out = await applyOuRefund(client, ACCOUNT_ID, 0.10, { isDuplicate });
    expect(out).not.toBeNull();
    expect(isDuplicate).toHaveBeenCalledTimes(1);
  });
});

// ── current_period_spend_usd ────────────────────────────────────────────────
// threshold-charge-service compares this counter against the $100/$200/$500/$1k
// graduated schedule. Without a writer it stays zero however much an account
// consumes, so a post_pay account's threshold charge could never fire.
//
// These tests pin the two properties that make it usable: consumption advances
// it by customer_cost_usd (dollars owed, the same denomination as the
// thresholds), and a refund walks it back down instead of letting it ratchet.
describe('current_period_spend_usd', () => {
  const ACCOUNT_ID = 'acct-1';

  function consumptionClient(ctrl: Record<string, string>) {
    let updateParams: unknown[] | undefined;
    let updateSql = '';
    const query = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE billing_controls') && sql.includes('current_period_spend_usd')) {
        updateSql = sql;
        updateParams = params;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('billing_system_settings')) {
        return { rows: [{ value: '0.01' }], rowCount: 1 };
      }
      if (sql.includes('FROM billing_controls') && sql.includes('FOR UPDATE')) {
        return { rows: [ctrl], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    return {
      client: { query, release: jest.fn() } as unknown as PoolClient,
      get params() { return updateParams; },
      get sql() { return updateSql; },
    };
  }

  // Core-plan shape: 1 OU = $0.01 raw, included rate $0.025/OU, plenty of
  // headroom so the whole drain lands in the included bucket.
  const CORE_CTRL = {
    plan_included_ous:         '800',
    precommit_extra_ous:       '0',
    // NOT NULL DEFAULT 0 in the schema (migration 415), so a real row always
    // carries it. Present here because this fixture stands in for that row and
    // the bucket split reads it to find the precommit end.
    referral_bonus_ous:        '0',
    included_rate_usd_per_ou:  '0.025',
    precommit_rate_usd_per_ou: '0.028',
    reload_rate_usd_per_ou:    '0.031250',
    ous_consumed_this_period:  '0',
  };

  it('advances by customer_cost_usd, in the same statement as the OU counter', async () => {
    const c = consumptionClient(CORE_CTRL);
    // $1.00 raw cost → 100 OUs → 100 × $0.025 = $2.50 owed.
    const assignments = await applyOuConsumption(c.client, ACCOUNT_ID, 1.0);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].costBucket).toBe('included');
    expect(assignments[0].ouConsumed).toBeCloseTo(100, 6);
    expect(assignments[0].customerCostUsd).toBeCloseTo(2.5, 6);

    // One UPDATE carries both counters, so they cannot diverge under the
    // FOR UPDATE the caller is holding.
    expect(c.sql).toContain('ous_consumed_this_period');
    expect(c.sql).toContain('current_period_spend_usd');
    expect(c.params?.[1]).toBeCloseTo(100, 6);   // OUs
    expect(c.params?.[2]).toBeCloseTo(2.5, 6);   // dollars owed
  });

  it('sums the per-bucket rates when a drain crosses a boundary', async () => {
    // 700 already consumed of 800 included, no precommit: $10 raw = 1000 OUs
    // splits 100 included ($0.025) + 900 reload ($0.03125).
    const c = consumptionClient({ ...CORE_CTRL, ous_consumed_this_period: '700' });
    const assignments = await applyOuConsumption(c.client, ACCOUNT_ID, 10.0);

    expect(assignments.map(a => a.costBucket)).toEqual(['included', 'reload']);
    const expected = 100 * 0.025 + 900 * 0.03125;
    expect(c.params?.[2]).toBeCloseTo(expected, 6);
    // The counter must track the rated sum, not the raw $10.
    expect(c.params?.[2]).not.toBeCloseTo(10, 6);
  });

  // The referee half of the referral programme grants bonus Operating Units to
  // the referred workspace's first billing period. They have to be spendable
  // capacity, not just a bigger number on the billing tab, or the share
  // message's promise of bonus usage is never actually kept.
  it('extends the precommit band by the referral bonus', async () => {
    // 800 included already consumed, 0 purchased precommit, 800 bonus. A drain
    // that would otherwise fall straight into reload lands in precommit
    // instead, which is the whole point of the grant.
    const c = consumptionClient({
      ...CORE_CTRL,
      referral_bonus_ous: '800',
      ous_consumed_this_period: '800',
    });

    const assignments = await applyOuConsumption(c.client, ACCOUNT_ID, 1.0);

    expect(assignments.map(a => a.costBucket)).toEqual(['precommit']);
    expect(assignments[0].ouConsumed).toBeCloseTo(100, 6);
  });

  it('is not advanced when the drain is zero-cost', async () => {
    const c = consumptionClient(CORE_CTRL);
    const assignments = await applyOuConsumption(c.client, ACCOUNT_ID, 0);
    expect(assignments).toEqual([]);
    expect(c.params).toBeUndefined();
  });

  it('is walked back down by a refund rather than ratcheting', async () => {
    let params: unknown[] | undefined;
    let sql = '';
    const query = jest.fn().mockImplementation(async (s: string, p?: unknown[]) => {
      if (s.includes('UPDATE billing_controls') && s.includes('GREATEST')) {
        sql = s; params = p;
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('billing_system_settings')) return { rows: [{ value: '0.01' }], rowCount: 1 };
      if (s.includes('FROM billing_controls') && s.includes('FOR UPDATE')) {
        return {
          rows: [{ ous_consumed_this_period: '1000', reload_rate_usd_per_ou: '0.031250' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: jest.fn() } as unknown as PoolClient;

    // $1.00 refunded → 100 OUs → 100 × $0.03125 = $3.125 credited back.
    const result = await applyOuRefund(client, ACCOUNT_ID, 1.0);

    expect(result?.ouRefunded).toBeCloseTo(100, 6);
    expect(result?.customerCreditUsd).toBeCloseTo(3.125, 6);
    expect(sql).toContain('current_period_spend_usd');
    expect(params?.[1]).toBeCloseTo(100, 6);      // OUs back
    expect(params?.[2]).toBeCloseTo(3.125, 6);    // dollars back
  });
});
