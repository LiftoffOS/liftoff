// BigQuery keyless connect router (implementation plan §3C/§5).
//
// BigQuery uses no stored secret (auth.kind='none'); it authenticates via
// per-tenant SA impersonation. Connect is a two-step, customer-in-the-loop
// flow that neither the OAuth, api-key, nor keypair routers model:
//   POST /connect  — provision the per-tenant SA + create the connector row,
//                    return the SA email + copy-paste IAM grant.
//   POST /verify   — re-probe after the customer runs the grant; flip 'active'.
//
// Mount path: /api/connectors/bigquery (see server.ts).

import { Router, Request, Response } from 'express';
import { logger } from '../infra/logging.js';
import { connectBigQuery, verifyBigQueryConnection } from './bigquery-connect.js';

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  return h && typeof h === 'string' && h.length > 0 ? h : null;
}

export const bigqueryRouter = Router();

// POST /connect — provision SA + create connector, return grant instructions.
bigqueryRouter.post('/connect', async (req: Request, res: Response) => {
  try {
    const { tenantId, projectId, dataset, name } = (req.body ?? {}) as {
      tenantId?: string;
      projectId?: string;
      dataset?: string;
      name?: string;
    };
    if (!getAccountId(req)) {
      return res.status(401).json({ error: 'Unauthorized (x-account-id header required)' });
    }
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const result = await connectBigQuery({ tenantId, projectId, dataset, name });
    logger.info(
      { tenantId, connectorId: result.connectorId, status: result.status },
      'connector.bigquery_connect_started',
    );
    return res.json(result);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'BigQuery connect failed');
    return res.status(500).json({ error: `Failed to connect BigQuery: ${(error as Error).message}` });
  }
});

// POST /verify — re-probe; flip 'active' once the grant is in place.
bigqueryRouter.post('/verify', async (req: Request, res: Response) => {
  try {
    const { tenantId, connectorId } = (req.body ?? {}) as { tenantId?: string; connectorId?: string };
    if (!tenantId || !connectorId) {
      return res.status(400).json({ error: 'tenantId and connectorId are required' });
    }
    const result = await verifyBigQueryConnection(tenantId, connectorId);
    logger.info({ tenantId, connectorId, status: result.status }, 'connector.bigquery_verify');
    return res.json({ connectorId, ...result });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'BigQuery verify failed');
    return res.status(500).json({ error: `Failed to verify BigQuery: ${(error as Error).message}` });
  }
});
