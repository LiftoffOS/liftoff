import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export async function reconcileVendorSpend(month: string /* YYYY-MM */): Promise<void> {
  const ours = await withAdminScope({ caller: 'web-tools.vendor-reconciliation', reason: 'cross-tenant cost_attribution_events reconciliation' }, (client) => client.query(
    `SELECT connector AS vendor, SUM(cost_usd) AS total
     FROM cost_attribution_events
     WHERE event_type  = 'web_tool'
       AND source      = 'tenant_runtime'
       AND date_trunc('month', occurred_at) = $1::date
     GROUP BY connector`,
    [`${month}-01`],
  ));
  for (const row of ours.rows) {
    log.info({ vendor: row.vendor, mtd_cost_usd: parseFloat(row.total), month }, 'vendor_spend_reconciliation');
  }
}
