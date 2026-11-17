// Action Ledger Service
// Per Section 5: Highest-priority DB client
// Per Section 1: Tenant runtime owns action ledger

import { Router } from 'express';
import { ActionLedgerService } from './service';

export const actionLedgerRouter = Router();
const service = new ActionLedgerService();

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
