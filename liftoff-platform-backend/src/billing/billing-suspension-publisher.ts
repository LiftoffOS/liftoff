// When an account's billing suspension changes, every tenant under it learns
// at once.
//
// `billing_controls.suspended` is account-keyed and is LEFT JOINed onto the
// entitlement snapshot the tenant runtime serves its admission gates from.
// A write to that flag moved no entitlement row, so it published nothing,
// and the runtime found out on its next refresh — a one-minute TTL. For a
// suspension that is a minute during which every run on the workspace keeps
// spending: a prepaid balance already at zero paid for another minute of
// tokens, browser hours and vendor calls, on every concurrent run. For an
// unsuspension it is a minute of refusals after the person has paid.
//
// This republishes the snapshot for each of the account's tenants — a
// version bump with no field changed, so `tenant.entitlement.updated`
// carries `billingSuspended` read from the joined truth — and the runtime's
// event subscriber applies it within seconds. Fail-isolated per tenant and
// never awaited on a money path: a publish that fails leaves the TTL refresh
// as the backstop it always was.

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { EntitlementService } from '../entitlements/service';

const entitlementService = new EntitlementService();

export type BillingSuspensionChange = 'suspended' | 'unsuspended';

export async function publishBillingSuspensionChange(
  accountId: string,
  change: BillingSuspensionChange,
  reason: string,
): Promise<void> {
  let tenantIds: string[] = [];
  try {
    tenantIds = await withAdminScope(
      { caller: 'billing-suspension-publisher', reason: 'list the account\'s tenants to republish their entitlement snapshots (no single tenant scope)' },
      async (client) => {
        const r = await client.query<{ tenant_id: string }>(
          `SELECT e.tenant_id FROM entitlements e
             JOIN tenants t ON t.id = e.tenant_id
            WHERE t.account_id = $1`,
          [accountId],
        );
        return r.rows.map((row) => row.tenant_id);
      },
    );
  } catch (err) {
    log.error({ accountId, change, reason, err: (err as Error).message },
      'billing-suspension-publisher: could not list the account\'s tenants; the runtime learns on its next refresh');
    return;
  }
  for (const tenantId of tenantIds) {
    try {
      await entitlementService.update(tenantId, {});
    } catch (err) {
      log.error({ accountId, tenantId, change, reason, err: (err as Error).message },
        'billing-suspension-publisher: republish failed for one tenant; it learns on its next refresh');
    }
  }
  log.info({ accountId, change, reason, tenants: tenantIds.length }, 'billing-suspension-publisher: snapshots republished');
}
