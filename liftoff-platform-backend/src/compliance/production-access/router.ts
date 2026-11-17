// Production Access Router
// Per Section 19: SOC 2 and GDPR readiness - production-access workflow
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router } from 'express';
import { ProductionAccessService } from './service';
import { getAuthenticatedUserId, isUnauthorizedError } from '../../infrastructure/auth-helpers';

export const productionAccessRouter = Router();
const service = new ProductionAccessService();

// Get request context from request
function getRequestContext(req: any) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'],
    userAgent: req.headers['user-agent'],
  };
}

// Request production access
productionAccessRouter.post('/request', async (req, res) => {
  try {
    const {
      requesterId,
      requesterEmail,
      accessLevel,
      reason,
      justification,
      targetResources,
      targetEnvironment,
      durationMinutes,
    } = req.body;

    const request = await service.requestAccess(
      {
        requesterId,
        requesterEmail,
        accessLevel,
        reason,
        justification,
        targetResources,
        targetEnvironment,
        durationMinutes,
      },
      getRequestContext(req)
    );

    res.status(201).json(request);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get pending access requests
productionAccessRouter.get('/pending', async (req, res) => {
  const requests = await service.getPendingRequests();
  res.json(requests);
});

// Get active accesses
productionAccessRouter.get('/active', async (req, res) => {
  const accesses = await service.getActiveAccesses();
  res.json(accesses);
});

// Get access statistics
productionAccessRouter.get('/stats', async (req, res) => {
  const stats = await service.getStats();
  res.json(stats);
});

// Get a specific access request
productionAccessRouter.get('/request/:id', async (req, res) => {
  const request = await service.getAccessRequest(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Access request not found' });
  }
  res.json(request);
});

// Approve an access request
// Per SE-004: Use authenticated user context instead of spoofable header
productionAccessRouter.post('/request/:id/approve', async (req, res) => {
  try {
    const approverId = getAuthenticatedUserId(req);
    const approverEmail = req.ctx?.userEmail as string;

    if (!approverEmail) {
      return res.status(400).json({ error: 'User email required' });
    }

    const request = await service.approveAccess(
      {
        requestId: req.params.id,
        approverId,
        approverEmail,
      },
      getRequestContext(req)
    );

    res.json(request);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Deny an access request
// Per SE-004: Use authenticated user context instead of spoofable header
productionAccessRouter.post('/request/:id/deny', async (req, res) => {
  try {
    const approverId = getAuthenticatedUserId(req);
    const approverEmail = req.ctx?.userEmail as string;
    const { reason } = req.body;

    if (!approverEmail) {
      return res.status(400).json({ error: 'User email required' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'Denial reason required' });
    }

    const request = await service.denyAccess(
      {
        requestId: req.params.id,
        approverId,
        approverEmail,
        reason,
      },
      getRequestContext(req)
    );

    res.json(request);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Revoke an access request
// Per SE-004: Use authenticated user context instead of spoofable header
productionAccessRouter.post('/request/:id/revoke', async (req, res) => {
  try {
    const revokedBy = getAuthenticatedUserId(req);
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Revocation reason required' });
    }

    await service.revokeAccess(
      {
        requestId: req.params.id,
        revokedBy,
        reason,
      },
      getRequestContext(req)
    );

    res.json({ revoked: true });
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Activate breakglass access
productionAccessRouter.post('/breakglass', async (req, res) => {
  try {
    const {
      requesterId,
      requesterEmail,
      incidentId,
      incidentSeverity,
      targetResources,
      targetEnvironment,
      justification,
    } = req.body;

    const breakglass = await service.activateBreakglass(
      {
        requesterId,
        requesterEmail,
        incidentId,
        incidentSeverity,
        targetResources,
        targetEnvironment,
        justification,
      },
      getRequestContext(req)
    );

    res.status(201).json(breakglass);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get active breakglass accesses
productionAccessRouter.get('/breakglass/active', async (req, res) => {
  const breakglass = await service.getActiveBreakglass();
  res.json(breakglass);
});

// Get a specific breakglass request
productionAccessRouter.get('/breakglass/:id', async (req, res) => {
  const breakglass = await service.getBreakglassRequest(req.params.id);
  if (!breakglass) {
    return res.status(404).json({ error: 'Breakglass request not found' });
  }
  res.json(breakglass);
});

// Record a breakglass action
// Per SE-004: Use authenticated user context instead of spoofable header
productionAccessRouter.post('/breakglass/:id/action', async (req, res) => {
  try {
    const performedBy = getAuthenticatedUserId(req);
    const { actionType, targetResource, actionDetails } = req.body;

    if (!actionType || !targetResource) {
      return res.status(400).json({ error: 'actionType and targetResource required' });
    }

    const action = await service.recordBreakglassAction(
      req.params.id,
      actionType,
      targetResource,
      actionDetails || {},
      performedBy
    );

    res.status(201).json(action);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Revoke breakglass access
// Per SE-004: Use authenticated user context instead of spoofable header
productionAccessRouter.post('/breakglass/:id/revoke', async (req, res) => {
  try {
    const revokedBy = getAuthenticatedUserId(req);
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Revocation reason required' });
    }

    await service.revokeAccess(
      {
        breakglassId: req.params.id,
        revokedBy,
        reason,
      },
      getRequestContext(req)
    );

    res.json({ revoked: true });
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Get audit trail
productionAccessRouter.get('/audit', async (req, res) => {
  const {
    userId,
    requestId,
    breakglassId,
    startDate,
    endDate,
    limit,
    offset,
  } = req.query;

  const entries = await service.getAuditTrail({
    userId: userId as string,
    requestId: requestId as string,
    breakglassId: breakglassId as string,
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    offset: offset ? parseInt(offset as string) : undefined,
  });

  res.json(entries);
});

// Process expired accesses (called by scheduler)
productionAccessRouter.post('/process-expired', async (req, res) => {
  const result = await service.processExpired();
  res.json(result);
});
