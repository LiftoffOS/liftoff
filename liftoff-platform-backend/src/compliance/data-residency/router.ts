// Data Residency Router
// Per Section 21: GDPR data residency controls

import { Router, Request, Response } from 'express';
import { tenantAuthMiddleware } from '../../infrastructure/middleware';
import { DataResidencyService } from './service';
import { CreateResidencyPolicyInput, UpdateResidencyPolicyInput, CreateTransferRequestInput } from './types';

const router = Router();

// Not mounted today, and these routes take the tenant from the request.
// Guarding here rather than at a mount that does not exist means whoever
// wires it up later cannot reintroduce the cross-tenant hole by forgetting.
router.use(tenantAuthMiddleware('viewDashboard'));
const service = new DataResidencyService();

// GET /compliance/data-residency/regions
router.get('/regions', async (_req: Request, res: Response) => {
  try {
    const regions = await service.getAvailableRegions();
    res.json({ regions });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /compliance/data-residency/policy/:tenantId
router.get('/policy/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const policy = await service.getPolicy(tenantId);

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    res.json({ policy });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/policy
router.post('/policy', async (req: Request, res: Response) => {
  try {
    const input: CreateResidencyPolicyInput = req.body;

    if (!input.tenantId || !input.primaryRegion || !input.regionGroup || !input.enforcementLevel) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, primaryRegion, regionGroup, enforcementLevel',
      });
    }

    const policy = await service.createPolicy(input);
    res.status(201).json({ policy });
  } catch (error) {
    if ((error as Error).message.includes('already exists')) {
      return res.status(409).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /compliance/data-residency/policy/:tenantId
router.patch('/policy/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const input: UpdateResidencyPolicyInput = req.body;

    const policy = await service.updatePolicy(tenantId, input);
    res.json({ policy });
  } catch (error) {
    if ((error as Error).message.includes('not found')) {
      return res.status(404).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/validate
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { tenantId, targetRegion, operation } = req.body;

    if (!tenantId || !targetRegion || !operation) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, targetRegion, operation',
      });
    }

    const result = await service.validateRegionAccess(tenantId, targetRegion, operation);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /compliance/data-residency/violations/:tenantId
router.get('/violations/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const unresolvedOnly = req.query.unresolvedOnly !== 'false';

    const violations = await service.getViolations(tenantId, unresolvedOnly);
    res.json({ violations });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/violations/:violationId/resolve
router.post('/violations/:violationId/resolve', async (req: Request, res: Response) => {
  try {
    const { violationId } = req.params;
    const { remediation } = req.body;

    if (!remediation) {
      return res.status(400).json({ error: 'Remediation description is required' });
    }

    await service.resolveViolation(violationId, remediation);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/transfer-requests
router.post('/transfer-requests', async (req: Request, res: Response) => {
  try {
    const input: CreateTransferRequestInput = req.body;

    if (!input.tenantId || !input.targetRegion || !input.purpose || !input.entityTypes || !input.requestedBy) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, targetRegion, purpose, entityTypes, requestedBy',
      });
    }

    const request = await service.requestTransfer(input);
    res.status(201).json({ request });
  } catch (error) {
    if ((error as Error).message.includes('not allowed')) {
      return res.status(403).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /compliance/data-residency/transfer-requests
router.get('/transfer-requests', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const requests = await service.getPendingTransfers(tenantId);
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/transfer-requests/:requestId/approve
router.post('/transfer-requests/:requestId/approve', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { approvedBy } = req.body;

    if (!approvedBy) {
      return res.status(400).json({ error: 'approvedBy is required' });
    }

    const request = await service.approveTransfer(requestId, approvedBy);
    res.json({ request });
  } catch (error) {
    if ((error as Error).message.includes('not found')) {
      return res.status(404).json({ error: (error as Error).message });
    }
    if ((error as Error).message.includes('not pending')) {
      return res.status(400).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /compliance/data-residency/transfer-requests/:requestId/reject
router.post('/transfer-requests/:requestId/reject', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { rejectedBy } = req.body;

    if (!rejectedBy) {
      return res.status(400).json({ error: 'rejectedBy is required' });
    }

    await service.rejectTransfer(requestId, rejectedBy);
    res.json({ success: true });
  } catch (error) {
    if ((error as Error).message.includes('not found')) {
      return res.status(404).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

export { router as dataResidencyRouter };
