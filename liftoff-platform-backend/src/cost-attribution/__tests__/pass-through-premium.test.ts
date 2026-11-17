/**
 * A supplier's own charge is resold at one premium, and the premium is the
 * same whatever the workspace pays per OU.
 *
 * `pass_through_premium` governs the class of cost the platform adds no work
 * of its own to: a data capability (`connector_call`) and a web tool
 * (`web_tool`). Platform work -- inference, the sandbox -- keeps the OU
 * definition and the workspace's markup, which is what keeps model tokens
 * priced as they were.
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { PoolClient } from 'pg';
import { applyOuConsumption, _resetOuDefinitionRateCacheForTesting } from '../ou-bucket-service';

const ACCOUNT_ID = 'acct-premium';

interface Ladder {
  consumed?:      number;
  includedOus?:   number;
  precommitOus?:  number;
  includedRate:   number;
  precommitRate?: number;
  reloadRate?:    number;
}

/** A client whose settings table holds `premium` (null = the row is absent)
 *  and whose billing_controls row is the given ladder. */
function buildClient(ladder: Ladder, premium: number | null) {
  const update: { ous?: number; spend?: number } = {};
  const query = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('billing_system_settings')) {
      if (sql.includes('pass_through_premium')) {
        return { rows: premium === null ? [] : [{ value: String(premium) }], rowCount: premium === null ? 0 : 1 };
      }
      return { rows: [{ value: '0.01' }], rowCount: 1 };   // the OU definition: 1 OU = 1 cent
    }
    if (sql.includes('FROM billing_controls') && sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          plan_included_ous:        String(ladder.includedOus ?? 0),
          precommit_extra_ous:      String(ladder.precommitOus ?? 0),
          referral_bonus_ous:       '0',
          included_rate_usd_per_ou:  ladder.includedRate.toFixed(6),
          precommit_rate_usd_per_ou: (ladder.precommitRate ?? ladder.includedRate).toFixed(6),
          reload_rate_usd_per_ou:    (ladder.reloadRate ?? ladder.includedRate).toFixed(6),
          ous_consumed_this_period: String(ladder.consumed ?? 0),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE billing_controls')) {
      update.ous = Number(params?.[1]);
      update.spend = Number(params?.[2]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query, release: jest.fn() } as unknown as PoolClient, update };
}

function charged(buckets: Awaited<ReturnType<typeof applyOuConsumption>>): number {
  return buckets.reduce((sum, b) => sum + b.customerCostUsd, 0);
}

beforeEach(() => _resetOuDefinitionRateCacheForTesting());

describe('pass-through pricing', () => {
  // A Locus-reached capability read costs the platform $0.02525.
  const SUPPLIER_COST = 0.02525;

  it('charges the supplier cost plus ten per cent at the list rate', async () => {
    const { client } = buildClient({ includedRate: 0.03125 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' });
    expect(charged(out)).toBeCloseTo(SUPPLIER_COST * 1.10, 10);
  });

  it('charges the same ten per cent on the cheapest plan rate', async () => {
    const { client } = buildClient({ includedRate: 0.02 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' });
    expect(charged(out)).toBeCloseTo(SUPPLIER_COST * 1.10, 10);
    // It takes MORE OUs to buy the same supplier dollar at a cheaper rate,
    // which is what a cheaper rate per OU means.
    const cheap = out.reduce((n, b) => n + b.ouConsumed, 0);
    const { client: listClient } = buildClient({ includedRate: 0.03125 }, 1.10);
    _resetOuDefinitionRateCacheForTesting();
    const list = (await applyOuConsumption(listClient, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' }))
      .reduce((n, b) => n + b.ouConsumed, 0);
    expect(cheap).toBeGreaterThan(list);
  });

  it('holds the premium exactly across a bucket boundary, whatever the ladder', async () => {
    // 1 OU of included allowance at $0.025, then $0.028, then $0.03125 --
    // a workspace whose three rates disagree.
    const { client } = buildClient(
      { includedOus: 1, precommitOus: 1, includedRate: 0.025, precommitRate: 0.028, reloadRate: 0.03125 },
      1.10,
    );
    const out = await applyOuConsumption(client, ACCOUNT_ID, 0.10, { chargeClass: 'pass_through' });
    expect(out.length).toBeGreaterThan(1);                 // it really did straddle
    expect(charged(out)).toBeCloseTo(0.10 * 1.10, 10);
  });

  it('leaves platform work priced at the OU definition and the workspace markup', async () => {
    const { client } = buildClient({ includedRate: 0.03125 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'platform' });
    // 2.525 OUs at $0.03125 -- the 3.125x markup, untouched.
    expect(out.reduce((n, b) => n + b.ouConsumed, 0)).toBeCloseTo(2.525, 10);
    expect(charged(out)).toBeCloseTo(SUPPLIER_COST * 3.125, 10);
  });

  it('prices pass-through cost as platform cost when no charge class is given', async () => {
    const { client } = buildClient({ includedRate: 0.03125 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST);
    expect(charged(out)).toBeCloseTo(SUPPLIER_COST * 3.125, 10);
  });

  it('prices pass-through cost as platform cost when the setting is absent', async () => {
    const { client } = buildClient({ includedRate: 0.03125 }, null);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' });
    expect(charged(out)).toBeCloseTo(SUPPLIER_COST * 3.125, 10);
  });

  it('charges an exempt workspace nothing and still meters it', async () => {
    const { client, update } = buildClient({ includedRate: 0 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' });
    expect(charged(out)).toBe(0);
    expect(out.reduce((n, b) => n + b.ouConsumed, 0)).toBeCloseTo(2.525, 10);
    expect(update.ous).toBeCloseTo(2.525, 10);
  });

  it('charges nothing for a keyless source, which costs nothing', async () => {
    const { client } = buildClient({ includedRate: 0.03125 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, 0, { chargeClass: 'pass_through' });
    expect(out).toEqual([]);
  });

  it('advances the period counters by the OUs the price bought', async () => {
    const { client, update } = buildClient({ includedRate: 0.03125 }, 1.10);
    const out = await applyOuConsumption(client, ACCOUNT_ID, SUPPLIER_COST, { chargeClass: 'pass_through' });
    expect(update.ous).toBeCloseTo(out.reduce((n, b) => n + b.ouConsumed, 0), 10);
    expect(update.spend).toBeCloseTo(SUPPLIER_COST * 1.10, 10);
  });
});
