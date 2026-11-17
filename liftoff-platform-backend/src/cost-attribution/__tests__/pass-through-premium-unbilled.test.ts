// A deployment that bills nobody charges no reseller premium.
//
// migration 519 defines pass_through_premium as the supplier's charge, times
// this, being what the workspace pays — a RESELLER'S margin on connector_call
// and web_tool. It seeds 1.10, so a fresh database has it whether or not
// anybody is reselling anything.
//
// With no billing system there is no reseller: the operator holds the account
// with the supplier and pays the supplier directly. Applying the premium there
// marks their own spend up by ten per cent and then shows them the marked-up
// figure as their cost. Same class as the $0-under-BYOK defect — every query
// succeeds, every card renders, and the total is wrong in a direction nobody
// thinks to check.
//
// This has its own file because the shared test setup sets STRIPE_SECRET_KEY
// (src/test-utils/setup.ts), so the whole suite runs as a Stripe deployment and
// the sibling pass-through-premium.test.ts asserts the premium APPLYING. Both
// directions are the point: the premium is correct when something is billing
// and wrong when nothing is.

import type { PoolClient } from 'pg';
import { getPassThroughPremium, _resetOuDefinitionRateCacheForTesting } from '../ou-bucket-service';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL = process.env.STRIPE_SECRET_KEY;

/** A client that would hand back the seeded 1.10 if anybody asked it. */
function clientWithSeededPremium() {
  const query = jest.fn().mockResolvedValue({ rows: [{ value: '1.100000' }] });
  return { client: { query } as unknown as PoolClient, query };
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL;
  _resetOuDefinitionRateCacheForTesting();
});

describe('pass-through premium under no billing system', () => {
  it('is null, and the setting is not even read', () => {
    delete process.env.STRIPE_SECRET_KEY;
    _resetOuDefinitionRateCacheForTesting();
    const { client, query } = clientWithSeededPremium();

    return getPassThroughPremium(client).then((premium) => {
      expect(premium).toBeNull();
      // Not consulted at all. The row exists in a fresh database because the
      // migration seeds it, so answering from the table would return 1.10.
      expect(query).not.toHaveBeenCalled();
    });
  });

  it('is still read and applied when Stripe is configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key';
    _resetOuDefinitionRateCacheForTesting();
    const { client, query } = clientWithSeededPremium();

    expect(await getPassThroughPremium(client)).toBe(1.1);
    expect(query).toHaveBeenCalled();
  });
});
