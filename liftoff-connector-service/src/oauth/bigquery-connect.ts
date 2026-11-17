// BigQuery keyless connect orchestration (implementation plan §3C/§5).
//
// Two-step connect (the customer must grant IAM between them):
//   1. connectBigQuery(): mint/ensure the per-tenant SA, create the connector
//      row (status 'pending'), return the SA email + copy-paste grant. The
//      first verify-probe will fail until the customer runs the grant.
//   2. verifyBigQueryConnection(): re-probe; on success flip status 'active'.
// The React connect UX (§3C) drives both: show grant → "Verify" → active.

import { logger } from '../infra/logging.js';
import {
  createConnector,
  updateConnectorStatus,
  getConnectorById,
} from './connector-ops.js';
import {
  ensurePerTenantServiceAccount,
  customerGrantInstructions,
} from '../clients/bigquery-provisioning.js';
import { probeWarehouseConnector } from '../credentials/warehouse-reachability-probe.js';

export interface BigQueryConnectInput {
  tenantId: string;
  projectId: string;
  dataset?: string;
  name?: string;
}

export interface BigQueryConnectResult {
  connectorId: string;
  serviceAccountEmail: string;
  grantInstructions: string;
  /** 'active' once the grant is in place + verified; 'pending_grant' until then. */
  status: 'active' | 'pending_grant';
  detail?: string;
}

/** Step 1: provision the SA + create the connector row, then attempt a verify. */
export async function connectBigQuery(input: BigQueryConnectInput): Promise<BigQueryConnectResult> {
  const { tenantId, projectId, dataset } = input;
  if (!projectId) throw new Error('BigQuery connect requires a projectId');

  const serviceAccountEmail = await ensurePerTenantServiceAccount(tenantId);
  const connector = await createConnector({
    tenantId,
    type: 'google_bigquery',
    name: input.name ?? `BigQuery (${projectId})`,
    config: { projectId, serviceAccountEmail, dataset },
  });

  const grantInstructions = customerGrantInstructions(serviceAccountEmail, projectId);
  // Best-effort immediate verify — usually 'pending_grant' on first connect
  // because the customer has not run the grant yet.
  const verify = await verifyBigQueryConnection(tenantId, connector.id);
  return {
    connectorId: connector.id,
    serviceAccountEmail,
    grantInstructions,
    status: verify.status,
    detail: verify.detail,
  };
}

/** Step 2 (and the "Verify" button): re-probe; flip 'active' on success. */
export async function verifyBigQueryConnection(
  tenantId: string,
  connectorId: string,
): Promise<{ status: 'active' | 'pending_grant'; detail?: string }> {
  const row = await getConnectorById(tenantId, connectorId);
  if (!row || row.type !== 'google_bigquery') {
    throw new Error(`connector ${connectorId} is not a BigQuery connector`);
  }
  const { outcome, detail } = await probeWarehouseConnector(tenantId, connectorId, 'google_bigquery');
  if (outcome === 'ok') {
    await updateConnectorStatus(tenantId, connectorId, 'active');
    logger.info({ tenantId, connectorId }, 'bigquery: connection verified → active');
    return { status: 'active' };
  }
  // Not reachable yet (grant missing / propagating) — stay pending; the UX
  // keeps showing the grant + Verify. Never a fabricated success.
  logger.info({ tenantId, connectorId, outcome, detail }, 'bigquery: verify not yet reachable');
  return { status: 'pending_grant', detail };
}
