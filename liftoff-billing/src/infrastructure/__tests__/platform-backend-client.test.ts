// The referral lookup's failure modes, which reach much further than referrals.
//
// It runs on EVERY paid subscription invoice, inside the Stripe consumer, so
// whatever it throws fails the whole event and Pub/Sub retries the entire
// invoice. That makes the difference between a 404 and a 500 a question about
// the estate rather than about this feature: a control plane rolled back to a
// revision predating the referral programme answers 404, and if that propagated
// it would take every subscription invoice down with it.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PlatformBackendClient } from '../platform-backend-client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (impl?: any): any => (jest.fn as any)(impl);
/* eslint-enable @typescript-eslint/no-explicit-any */

const BASE = 'https://platform-backend.test.invalid';
const TOKEN = 'test-billing-service-token-32chars';
const TENANT = '11111111-1111-4111-8111-111111111111';

function respond(status: number, body: unknown) {
  global.fetch = fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('referralLookup', () => {
  it('returns the referral when the control plane knows of one', async () => {
    respond(200, { referral: { referralId: 'r1', referrerTenantId: 'tenant-a' } });

    const client = new PlatformBackendClient(BASE, TOKEN);

    expect(await client.referralLookup(TENANT)).toMatchObject({ referralId: 'r1' });
  });

  it('returns null when nobody referred the workspace', async () => {
    // The ordinary answer for almost every invoice.
    respond(200, { referral: null });

    const client = new PlatformBackendClient(BASE, TOKEN);

    expect(await client.referralLookup(TENANT)).toBeNull();
  });

  it('reads a 404 as "not referred" rather than failing the invoice', async () => {
    // A control plane without the endpoint has never heard of referrals, which
    // is exactly "this workspace was not referred". Throwing here would make a
    // rollback of the control plane break every subscription invoice.
    respond(404, { error: 'Not Found' });

    const client = new PlatformBackendClient(BASE, TOKEN);

    expect(await client.referralLookup(TENANT)).toBeNull();
  });

  it('still throws on a 5xx, so the referral is retried rather than lost', async () => {
    // Degraded, not absent. The invoice event fails and Pub/Sub redelivers;
    // swallowing it would leave a referrer permanently unpaid with nothing
    // recorded anywhere.
    respond(503, { error: 'unavailable' });

    const client = new PlatformBackendClient(BASE, TOKEN);

    await expect(client.referralLookup(TENANT)).rejects.toThrow('503');
  });

  it('still throws when the signature is rejected', async () => {
    // A 401 is a misconfiguration, not an answer about this workspace.
    respond(401, { error: 'unauthorized' });

    const client = new PlatformBackendClient(BASE, TOKEN);

    await expect(client.referralLookup(TENANT)).rejects.toThrow('401');
  });

  it('returns null when no control plane is configured at all', async () => {
    // Local dev and tests, where PLATFORM_BACKEND_URL is unset.
    const client = new PlatformBackendClient('', TOKEN);

    expect(await client.referralLookup(TENANT)).toBeNull();
  });
});

describe('the 404 tolerance is opt-in', () => {
  it('does not leak to other JSON callers', async () => {
    // checkDeletionHistory shares callJson. For it a 404 IS a failure, and
    // swallowing one would silently report "no prior deletion" for an account
    // that had one — which is an abuse-detection answer, not a routing fact.
    respond(404, { error: 'Not Found' });

    const client = new PlatformBackendClient(BASE, TOKEN);

    await expect(client.checkDeletionHistory('somehash')).rejects.toThrow('404');
  });
});
