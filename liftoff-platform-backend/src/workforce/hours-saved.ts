// Hours-saved estimate for the 30-day metric tiles on /dashboard and /teams.
//
// Moved server-side from the React useTeamStats hook so the frontend no longer
// downloads up to 500 raw audit rows (~485KB, with input_args/snapshot blobs)
// to sum per-action weights client-side. The GROUP BY covers every successful
// action in the window, so the result is exact — the old client path sampled
// the newest 500 rows and extrapolated by the total count.

import { withTenantScope } from '../infrastructure/database';

// Estimated hours a human would spend on each action type.
const ACTION_HOURS_WEIGHTS: Record<string, number> = {
  analyze_data: 2.0,
  analyze_sentiment: 0.5,
  categorize_issue: 0.25,
  create_invoice: 1.0,
  create_ticket: 0.5,
  generate_report: 2.0,
  predict_trends: 3.0,
  process_refund: 1.0,
  respond_to_ticket: 0.5,
  review_code: 1.5,
  route_inquiry: 0.25,
  schedule_meeting: 0.25,
  send_email: 0.25,
  send_notification: 0.1,
  sync_data: 1.0,
  update_crm_record: 0.5,
  update_subscription: 0.5,
};
const DEFAULT_HOURS_PER_TASK = 0.5;

export interface ActionCountRow {
  action: string;
  cnt: number;
}

/** Pure weighting step, split out for unit tests. */
export function weightHours(rows: ActionCountRow[]): number {
  const weighted = rows.reduce(
    (sum, row) => sum + (ACTION_HOURS_WEIGHTS[row.action] ?? DEFAULT_HOURS_PER_TASK) * Number(row.cnt),
    0,
  );
  return Math.round(weighted);
}

export async function getHoursSaved30d(tenantId: string): Promise<number> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT action, COUNT(*)::int AS cnt
     FROM agent_audit_logs
     WHERE tenant_id = $1
       AND outcome = 'success'
       AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY action`,
    [tenantId],
  ));
  return weightHours(result.rows as ActionCountRow[]);
}
