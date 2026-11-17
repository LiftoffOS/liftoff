/**
 * A reload call fired by a request can be waited for by that request.
 *
 * This service runs on request-based CPU, so a call still in flight when its
 * request answers stalls until some later request arrives. The scheduled cost
 * pass waits on settlePendingAutoReloads before it answers; these pin that the
 * wait covers every call fired, and that a failed call neither rejects the
 * wait nor stays pending forever.
 */
jest.mock('../agents-stalled-notify', () => ({ notifyAgentsStalled: jest.fn() }));
const triggerAutoReload = jest.fn();
jest.mock('../../billing/billing-admin-client', () => ({ getBillingAdminClient: () => ({ triggerAutoReload }) }));

import { fireAutoReloadClaim, settlePendingAutoReloads } from '../reload-drain';

const claim = { stripeCustomerId: 'cus_1', autoReloadAmountUsd: '25.00' };

beforeEach(() => triggerAutoReload.mockReset());

it('waits for every reload call fired before it', async () => {
  const releases: Array<() => void> = [];
  triggerAutoReload.mockImplementation(() => new Promise<void>((r) => { releases.push(r); }));
  fireAutoReloadClaim(claim, 'acct-1', 'tenant-1', 'test');
  fireAutoReloadClaim(claim, 'acct-2', 'tenant-2', 'test');

  let settled = false;
  const wait = settlePendingAutoReloads().then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false);
  releases[0]();
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false);
  releases[1]();
  await wait;
  expect(settled).toBe(true);
});

it('resolves when a call fails, and forgets it', async () => {
  triggerAutoReload.mockRejectedValue(new Error('billing down'));
  fireAutoReloadClaim(claim, 'acct-1', 'tenant-1', 'test');
  await expect(settlePendingAutoReloads()).resolves.toBeUndefined();
  await expect(settlePendingAutoReloads()).resolves.toBeUndefined();
});

it('returns at once when nothing is in flight', async () => {
  await expect(settlePendingAutoReloads()).resolves.toBeUndefined();
});
