// PR2 implementation. Looks up the vendor_session_id for a pending
// `intervention.requested` envelope (keyed by request_id) via the
// anchor_webhook_events audit table, resolves the tenant via the bound
// web_sessions row, then forwards the operator's reply to Anchor's
// /agent/respond-to-human-intervention endpoint.

import { getPool } from '../../infrastructure/database';
import { respondToIntervention } from '../../browser-sessions/session-vendor-proxy';

export async function forwardAnchorInterventionResponse(
  vendorRequestId: string,
  response: string,
): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT vendor_session_id
     FROM anchor_webhook_events
     WHERE event_type = 'intervention.requested'
       AND payload->'data'->>'requestId' = $1
     ORDER BY received_at DESC LIMIT 1`,
    [vendorRequestId],
  );
  if (result.rows.length === 0) {
    throw new Error(`no recorded intervention.requested for request_id=${vendorRequestId}`);
  }
  const vendorSessionId = result.rows[0].vendor_session_id as string;
  // Resolve tenant via web_sessions (the webhook envelope's project_id is
  // Anchor's internal id, not ours).
  const session = await pool.query(
    `SELECT tenant_id FROM web_sessions WHERE vendor_session_id = $1 LIMIT 1`,
    [vendorSessionId],
  );
  if (session.rows.length === 0) {
    throw new Error(`no web_session for vendor_session_id=${vendorSessionId}`);
  }
  await respondToIntervention(
    vendorSessionId, session.rows[0].tenant_id, vendorRequestId, response,
  );
}
