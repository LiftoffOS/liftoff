import { getPool } from '../../infrastructure/database';
import { ANY_CONNECTOR } from './credential-scope';
import { getWebToolCredential, VendorNotConnected, VendorConnectorErrored } from './web-tool-secrets';
import { logger } from '../../infrastructure/logging';

interface AnchorEnvelopeShape {
  type: string;
  data: { session_id?: string } & Record<string, unknown>;
}

export async function resolveAnchorWebhookSecret(envelope: AnchorEnvelopeShape): Promise<string | null> {
  const sessionId = envelope.data?.session_id;
  if (!sessionId) return null;

  const pool = getPool();
  const sessionLookup = await pool.query(
    `SELECT tenant_id FROM web_sessions WHERE vendor_session_id = $1 LIMIT 1`,
    [sessionId],
  );
  if (sessionLookup.rows.length === 0) return null;
  const tenantId = sessionLookup.rows[0].tenant_id as string;

  let cred;
  try {
    // A webhook for a session the workspace already holds; the row does not
    // record which connector opened it, so any of the workspace's applies.
    cred = await getWebToolCredential(tenantId, 'anchor_browser', ANY_CONNECTOR);
  } catch (err) {
    if (err instanceof VendorNotConnected || err instanceof VendorConnectorErrored) return null;
    throw err;
  }
  const secret = cred.extra?.webhook_secret;
  if (!secret) {
    logger.warn({ tenantId }, 'anchor connector missing extra.webhook_secret');
    return null;
  }
  return secret;
}
