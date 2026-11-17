// GDPR Data Subject Handler
// Handles erasure requests scoped to a user or full tenant.
// Requests are authenticated via HMAC to prevent unauthorized invocation.

import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';

interface DataSubjectRequest {
  tenantId: string;
  subjectUserId: string | null;
  scope: 'user' | 'tenant';
  requestedBy: string;
  expiresAt: Date;
  authorizationHmac: Buffer;
}

export function registerDataSubjectRoutes(app: FastifyInstance): void {
  // POST /internal/data-subject/erase
  app.post('/internal/data-subject/erase', async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const raw = request.body as {
      tenantId?: string;
      subjectUserId?: string | null;
      scope?: string;
      requestedBy?: string;
      expiresAt?: string;
      authorizationHmac?: string | Buffer;
    };

    if (!raw.tenantId || !raw.scope || !raw.requestedBy || !raw.expiresAt || !raw.authorizationHmac) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const body: DataSubjectRequest = {
      tenantId: raw.tenantId,
      subjectUserId: raw.subjectUserId ?? null,
      scope: raw.scope as 'user' | 'tenant',
      requestedBy: raw.requestedBy,
      expiresAt: new Date(raw.expiresAt),
      authorizationHmac:
        Buffer.isBuffer(raw.authorizationHmac)
          ? raw.authorizationHmac
          : Buffer.from(raw.authorizationHmac as string, 'hex'),
    };

    if (!validateHmac(body)) {
      return reply.code(401).send({ error: 'Invalid authorization' });
    }

    if (body.expiresAt < new Date()) {
      return reply.code(401).send({ error: 'Request expired' });
    }

    if (body.scope !== 'user' && body.scope !== 'tenant') {
      return reply.code(400).send({ error: 'scope must be "user" or "tenant"' });
    }

    const pool = await getPool();

    if (body.scope === 'user' && body.subjectUserId) {
      // Revoke all active credentials for the user
      await pool.query(
        `UPDATE developer_proxy_credentials
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
        [body.tenantId, body.subjectUserId],
      );

      // Pseudonymize usage log entries for GDPR compliance
      await pool.query(
        `UPDATE developer_proxy_usage_log
         SET user_id = '[deleted]'
         WHERE tenant_id = $1 AND user_id = $2`,
        [body.tenantId, body.subjectUserId],
      );
    } else {
      // Tenant scope: revoke all active credentials for the entire tenant
      await pool.query(
        `UPDATE developer_proxy_credentials
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND status = 'active'`,
        [body.tenantId],
      );
    }

    return reply.send({ success: true });
  });
}

function validateHmac(body: DataSubjectRequest): boolean {
  const secret = process.env.DATA_SUBJECT_HMAC_SECRET;
  if (!secret) return false;

  const message = [
    body.tenantId,
    body.subjectUserId ?? '',
    body.scope,
    body.requestedBy,
    body.expiresAt.getTime().toString(),
  ].join('|');

  const expected = createHmac('sha256', secret).update(message).digest();

  try {
    return timingSafeEqual(Buffer.from(body.authorizationHmac), expected);
  } catch {
    return false;
  }
}
