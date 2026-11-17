// pending-integration-resolver.ts
//
// OAuth callback handler for workforce-plan pending integrations.
//
// When the CAIO detects that a connector must be authorised before a plan can
// proceed, it creates a `plan_pending_integrations` row via
// `createPendingIntegration()` and surfaces the OAuth URL to the user. Once
// the user completes the OAuth flow the provider redirects to:
//
//   GET /workforce-plans/integrations/callback?state=<hmac>&connector_id=<uuid>
//
// This handler looks up the pending row, marks it resolved, and returns the
// resolved plan/spec info to the caller (typically the frontend, which can
// re-submit the planning request).
//
// Import paths use .js extensions (ESM).

import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';
import { writeAuditLog } from './audit-log.js';

interface PendingIntegrationRow {
  id: string;
  plan_id: string;
  tenant_id: string;
  account_id: string;
  spec_id: string;
  connector_type: string;
  nonce: string;
}

/**
 * Register the OAuth callback route on the Fastify instance.
 *
 * Route: GET /workforce-plans/integrations/callback
 * Query params:
 *   - state       : the oauth_state_hmac value produced by createPendingIntegration()
 *   - connector_id: UUID of the newly connected connector
 */
export async function registerPendingIntegrationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{
    Querystring: { state?: string; connector_id?: string };
  }>('/workforce-plans/integrations/callback', async (request, reply) => {
    const { state, connector_id: connectorId } = request.query;

    if (!state || !connectorId) {
      return reply.status(400).send({ error: 'MISSING_PARAMS' });
    }

    const pool = getPool();

    // Look up the pending integration by HMAC. Must be unresolved and not expired.
    const lookupResult = await pool.query<PendingIntegrationRow>(
      `SELECT id, plan_id, tenant_id, account_id, spec_id, connector_type, nonce
       FROM plan_pending_integrations
       WHERE oauth_state_hmac = $1
         AND resolved_at IS NULL
         AND expires_at > NOW()`,
      [state],
    );

    if (lookupResult.rowCount === 0) {
      log.warn({ state }, 'pending-integration-resolver: no matching pending integration found');
      return reply.status(404).send({ error: 'INTEGRATION_NOT_FOUND' });
    }

    const row = lookupResult.rows[0];

    // Mark as resolved.
    await pool.query(
      `UPDATE plan_pending_integrations
       SET resolved_at = NOW(), connector_id = $1
       WHERE id = $2`,
      [connectorId, row.id],
    );

    void writeAuditLog(
      'workforce_plans.pending_integration_resolved',
      { tenantId: row.tenant_id as string, accountId: row.account_id as string },
      {
        planId: row.plan_id,
        specId: row.spec_id,
        connectorType: row.connector_type,
        connectorId,
      },
    );

    log.info(
      {
        tenantId: row.tenant_id,
        accountId: row.account_id,
        planId: row.plan_id,
        specId: row.spec_id,
        connectorType: row.connector_type,
        connectorId,
      },
      'pending-integration-resolver: integration resolved',
    );

    return reply.status(200).send({
      resolved: true,
      planId: row.plan_id,
      specId: row.spec_id,
      connectorType: row.connector_type,
    });
  });
}

/**
 * Create a pending integration row for an OAuth flow that has not yet been
 * completed by the user.
 *
 * @param planId        - UUID of the workforce plan awaiting the connector
 * @param tenantId      - UUID of the tenant
 * @param accountId     - UUID of the account (user) initiating the flow
 * @param specId        - Connector spec identifier (e.g. "greenhouse-ats")
 * @param connectorType - Connector type string (e.g. "ats", "hris")
 * @param secret        - HMAC secret used to sign the state token
 * @param ttlSeconds    - How long the pending integration is valid (default 1 hour)
 * @returns             - The HMAC state token and nonce to embed in the OAuth URL
 */
export async function createPendingIntegration(
  planId: string,
  tenantId: string,
  accountId: string,
  specId: string,
  connectorType: string,
  secret: string,
  ttlSeconds = 3600,
): Promise<{ hmac: string; nonce: string }> {
  const nonce = randomBytes(16).toString('hex');

  // Sign the key fields to produce a forgery-resistant state token.
  const hmac = createHmac('sha256', secret)
    .update([planId, tenantId, accountId, nonce].join('|'))
    .digest('hex');

  const pool = getPool();

  await pool.query(
    `INSERT INTO plan_pending_integrations
       (plan_id, tenant_id, account_id, spec_id, connector_type, oauth_state_hmac, nonce, expires_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' seconds')::interval)`,
    [planId, tenantId, accountId, specId, connectorType, hmac, nonce, ttlSeconds],
  );

  log.info(
    { tenantId, accountId, planId, specId, connectorType },
    'pending-integration-resolver: created pending integration',
  );

  return { hmac, nonce };
}
