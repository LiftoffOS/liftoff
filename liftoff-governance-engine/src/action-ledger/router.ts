// Action Ledger Service
// Per Section 5: Highest-priority DB client
// Per Section 1: Tenant runtime owns action ledger

import { Router } from 'express';
import { ActionLedgerService } from './service';

export const actionLedgerRouter = Router();
const service = new ActionLedgerService();

// Cost attribution ingestion feed for platform-backend's governance-ingester.
// Returns paginated completed/failed action rows across all tenants since a
// cursor timestamp. Auth is handled globally (X-Service-Auth / GOVERNANCE_SERVICE_TOKEN).
//
// GET /api/governance/actions/ingestion-feed
//   ?tenantId=<uuid>   (required) tenant to query
//   &since=<ISO>       (required) cursor — returns rows with created_at > since
//   &limit=<n>         (optional, default 500, max 1000)
//
// Response: { rows: [...], hasMore: boolean, nextSince: string | null }
// nextSince is the ISO timestamp of the last row's created_at (for use as
// the next `since` value), or null when the result set is empty.
actionLedgerRouter.get('/ingestion-feed', async (req, res) => {
  const { tenantId, since, limit: limitRaw } = req.query;

  if (!tenantId || typeof tenantId !== 'string') {
    return res.status(400).json({ error: 'tenantId query param is required' });
  }
  if (!since || typeof since !== 'string') {
    return res.status(400).json({ error: 'since query param is required (ISO timestamp)' });
  }

  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) {
    return res.status(400).json({ error: 'since must be a valid ISO timestamp' });
  }

  const limit = Math.min(
    limitRaw !== undefined ? parseInt(limitRaw as string, 10) || 500 : 500,
    1000,
  );

  const rows = await service.listActionsForIngestion(tenantId, sinceDate, limit);

  const hasMore = rows.length === limit;
  const nextSince =
    rows.length > 0
      ? (rows[rows.length - 1].createdAt as Date).toISOString()
      : null;

  return res.json({ rows, hasMore, nextSince });
});

// Get action by ID
actionLedgerRouter.get('/:id', async (req, res) => {
  const action = await service.getById(req.params.id);
  if (!action) {
    return res.status(404).json({ error: 'Action not found' });
  }
  res.json(action);
});

// Get actions for a workflow
actionLedgerRouter.get('/workflow/:workflowId', async (req, res) => {
  const actions = await service.getByWorkflowId(req.params.workflowId);
  res.json(actions);
});

// Get actions by idempotency key (for reconciliation)
actionLedgerRouter.get('/idempotency/:key', async (req, res) => {
  const action = await service.getByIdempotencyKey(req.params.key);
  res.json(action);
});
