// Tests for PR 6 — enterprise-orphan scan script's report-builder filter.
//
// The scan script itself wires DB + service helpers + Stripe; here we
// exercise the pure `buildReport` helper to lock down the filter
// invariant: only accounts whose `issues.length > 0` make it into the
// `flagged` array.

import { buildReport, type ScannedAccount } from './list-enterprise-accounts-with-orphan-state';
import type { AccountStateSnapshot } from '../admin/account-state-service';

function fakeSnapshot(accountId: string, email: string): AccountStateSnapshot {
  return {
    account: { id: accountId, email, stripeCustomerId: 'cus_test', isPlatformAdmin: false },
    tenants: [],
    entitlements: [],
    billingControls: null,
    contract: null,
    subscriptions: [],
    stripe: {
      activeSubscription: null,
      allSubscriptions: [],
      orphanSubscriptions: [],
      searchAvailable: true,
    },
  };
}

function scanned(accountId: string, email: string, issues: string[]): ScannedAccount {
  return {
    accountId,
    email,
    snapshot: fakeSnapshot(accountId, email),
    issues,
  };
}

describe('buildReport (PR 6 scan filter)', () => {
  it('filters to accounts with issues.length > 0', () => {
    const input: ScannedAccount[] = [
      scanned('acct-clean-1', 'clean1@example.com', []),
      scanned('acct-dirty-1', 'dirty1@example.com', ['stripe_orphan_subscriptions_present']),
      scanned('acct-clean-2', 'clean2@example.com', []),
      scanned(
        'acct-dirty-2',
        'dirty2@example.com',
        ['stripe_active_sub_customer_mismatch', 'billing_controls_suspended_but_stripe_active'],
      ),
    ];

    const report = buildReport(input);

    expect(report.totalEnterpriseAccounts).toBe(4);
    expect(report.flaggedAccounts).toBe(2);
    expect(report.flagged.map((f) => f.accountId)).toEqual(['acct-dirty-1', 'acct-dirty-2']);
    expect(report.flagged[0].issues).toEqual(['stripe_orphan_subscriptions_present']);
    expect(report.flagged[1].issues).toEqual([
      'stripe_active_sub_customer_mismatch',
      'billing_controls_suspended_but_stripe_active',
    ]);
  });

  it('emits scannedAt as an ISO-8601 timestamp', () => {
    const report = buildReport([]);
    expect(report.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('returns flaggedAccounts=0 + empty flagged[] when every account is clean', () => {
    const report = buildReport([
      scanned('acct-a', 'a@example.com', []),
      scanned('acct-b', 'b@example.com', []),
    ]);
    expect(report.totalEnterpriseAccounts).toBe(2);
    expect(report.flaggedAccounts).toBe(0);
    expect(report.flagged).toEqual([]);
  });

  it('returns totalEnterpriseAccounts=0 + flaggedAccounts=0 on empty input', () => {
    const report = buildReport([]);
    expect(report.totalEnterpriseAccounts).toBe(0);
    expect(report.flaggedAccounts).toBe(0);
    expect(report.flagged).toEqual([]);
  });

  it('preserves the original issue ordering per account', () => {
    const ordered = ['stripe_orphan_subscriptions_present', 'contract_present_but_tier_not_enterprise'];
    const report = buildReport([scanned('acct-x', 'x@example.com', ordered)]);
    expect(report.flagged[0].issues).toEqual(ordered);
  });

  it('does NOT include the full snapshot in the report (operator-facing summary only)', () => {
    const report = buildReport([scanned('acct-dirty', 'd@example.com', ['stripe_search_unavailable'])]);
    const flaggedEntry = report.flagged[0] as Record<string, unknown>;
    expect(flaggedEntry).not.toHaveProperty('snapshot');
    expect(Object.keys(flaggedEntry).sort()).toEqual(['accountId', 'email', 'issues']);
  });
});
