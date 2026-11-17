import { getPool } from '../infrastructure/database';
import { publishEvent } from '../events/publisher';
import { logAudit } from '../infrastructure/logging';

export async function revokeIdentity(
  tenantId: string,
  identityName: string,
  ctx: { actor: string },
): Promise<{ revoked: boolean; sessions_terminated: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idRow = await client.query(
      `SELECT id, vendor_identity_id, vendor FROM web_identities
       WHERE tenant_id = $1 AND identity_name = $2 AND revoked_at IS NULL FOR UPDATE`,
      [tenantId, identityName],
    );
    if (idRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return { revoked: false, sessions_terminated: 0 };
    }
    const vendorIdentityId = idRow.rows[0].vendor_identity_id;
    await client.query(
      `UPDATE web_identities SET revoked_at = now() WHERE id = $1`,
      [idRow.rows[0].id],
    );
    const sessions = await client.query(
      `SELECT id FROM web_sessions
       WHERE tenant_id = $1 AND closed_at IS NULL AND vendor_metadata->>'vendor_identity_id' = $2`,
      [tenantId, vendorIdentityId],
    );
    await client.query(
      `UPDATE web_sessions SET expires_at = now() - INTERVAL '1 second'
       WHERE id = ANY($1::uuid[])`,
      [sessions.rows.map(r => r.id)],
    );
    await client.query('COMMIT');

    publishEvent({
      entityType: 'web_identity',
      entityId: idRow.rows[0].id,
      eventType: 'tenant.web_identity.revoked',
      entityVersion: 1,
      eventVersion: 1,
      tenantId,
      payload: { identityName, vendorIdentityId, sessionsAffected: sessions.rows.length, actor: ctx.actor },
    }).catch(() => {});

    logAudit('web_identity.revoke', {
      tenantId, userId: ctx.actor, operation: 'web_identity.revoke',
    }, { identity_name: identityName, sessions_terminated: sessions.rows.length });

    return { revoked: true, sessions_terminated: sessions.rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
