// Operator Dashboard Router
// Per Section 17: Control-plane visibility for operators

import { Router } from 'express';
import { OperatorDashboardService } from './service';
import { adminAuthMiddleware } from '../admin/middleware';

export const operatorDashboardRouter = Router();
const service = new OperatorDashboardService();

// All operator dashboard endpoints require platform admin access.
operatorDashboardRouter.use(adminAuthMiddleware);

// Get complete dashboard summary
operatorDashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const summary = await service.getDashboardSummary();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// Get system health
operatorDashboardRouter.get('/system-health', async (req, res, next) => {
  try {
    const health = await service.getSystemHealth();
    res.json(health);
  } catch (error) {
    next(error);
  }
});

// Get workflow health
operatorDashboardRouter.get('/workflow-health', async (req, res, next) => {
  try {
    const health = await service.getWorkflowHealth();
    res.json(health);
  } catch (error) {
    next(error);
  }
});

// Get connector health
operatorDashboardRouter.get('/connector-health', async (req, res, next) => {
  try {
    const health = await service.getConnectorHealth();
    res.json(health);
  } catch (error) {
    next(error);
  }
});

// Get usage summary
operatorDashboardRouter.get('/usage', async (req, res, next) => {
  try {
    const usage = await service.getUsageSummary();
    res.json(usage);
  } catch (error) {
    next(error);
  }
});

// Get tenant health list
operatorDashboardRouter.get('/tenants', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const tenants = await service.getTenantHealthList(limit);
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

// Get single tenant health
operatorDashboardRouter.get('/tenants/:tenantId', async (req, res, next) => {
  try {
    const health = await service.getTenantHealth(req.params.tenantId);
    if (!health) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json(health);
  } catch (error) {
    next(error);
  }
});

// B4: escalations only the platform can clear, for one tenant.
//
// Every other route on this dashboard reads the control-plane database. This
// one crosses to the tenant runtime, because that is where workflow_escalations
// lives, and because without it `system_internal` records would be visible to
// nobody at all: they correctly leave the customer queue, and no other internal
// surface shows them.
//
// Tenant-scoped rather than global on purpose. The runtime is per tenant, so
// "all tenants' records" would mean fanning out across every runtime on one
// request, and a single cold instance would then decide how long the page takes.
operatorDashboardRouter.get('/tenants/:tenantId/operator-records', async (req, res, next) => {
  try {
    const rawStatus = req.query.status;
    if (rawStatus !== undefined && rawStatus !== 'pending' && rawStatus !== 'resolved') {
      res.status(400).json({ error: "status must be 'pending' or 'resolved'" });
      return;
    }
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? undefined : parseInt(rawLimit as string, 10);
    if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }

    const { tenantRuntimeClient } = await import('../connectors/tenant-runtime-client');
    const records = await tenantRuntimeClient.listOperatorEscalationRecords(
      req.params.tenantId,
      { status: rawStatus as 'pending' | 'resolved' | undefined, limit },
    );
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

// Get recent audit logs
operatorDashboardRouter.get('/audit-logs', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const logs = await service.getRecentAuditLogs(limit);
    res.json(logs);
  } catch (error) {
    next(error);
  }
});

// Acknowledge an alert
operatorDashboardRouter.post('/alerts/:alertId/acknowledge', async (req, res, next) => {
  try {
    // adminAuthMiddleware has already verified identity and attached adminAccount
    const acknowledgedBy = (req as any).adminAccount.id;
    await service.acknowledgeAlert(req.params.alertId, acknowledgedBy);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
