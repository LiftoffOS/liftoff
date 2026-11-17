// Data Management Router
// Per Section 21: SOC 2 and GDPR compliance APIs
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router } from 'express';
import { DeletionService } from './deletion-service';
import { ExportService } from './export-service';
import { RetentionService } from './retention-service';
import { getAuthenticatedUserId, isUnauthorizedError } from '../infrastructure/auth-helpers';

export const dataManagementRouter = Router();

const deletionService = new DeletionService();
const exportService = new ExportService();
const retentionService = new RetentionService();

// ============================================================================
// Retention Policies
// ============================================================================

// Get all retention policies
dataManagementRouter.get('/retention-policies', async (req, res) => {
  const policies = await retentionService.getAllPolicies();
  res.json(policies);
});

// Get retention policy by ID
dataManagementRouter.get('/retention-policies/:id', async (req, res) => {
  const policy = await retentionService.getPolicy(req.params.id);
  if (!policy) {
    return res.status(404).json({ error: 'Retention policy not found' });
  }
  res.json(policy);
});

// Create retention policy
dataManagementRouter.post('/retention-policies', async (req, res) => {
  const { name, entityType, dataClassification, retentionDays, deletionStrategy, archiveBeforeDelete } = req.body;

  if (!name || !entityType || !dataClassification || !retentionDays || !deletionStrategy) {
    return res.status(400).json({
      error: 'name, entityType, dataClassification, retentionDays, and deletionStrategy are required',
    });
  }

  const policy = await retentionService.createPolicy({
    name,
    entityType,
    dataClassification,
    retentionDays,
    deletionStrategy,
    archiveBeforeDelete,
  });

  res.status(201).json(policy);
});

// Update retention policy
dataManagementRouter.patch('/retention-policies/:id', async (req, res) => {
  const policy = await retentionService.updatePolicy(req.params.id, req.body);
  res.json(policy);
});

// Disable retention policy
dataManagementRouter.delete('/retention-policies/:id', async (req, res) => {
  await retentionService.disablePolicy(req.params.id);
  res.status(204).send();
});

// Get retention statistics
dataManagementRouter.get('/retention/stats', async (req, res) => {
  const stats = await retentionService.getRetentionStats();
  res.json(stats);
});

// Manual retention cleanup for operators. The weekly scheduler uses
// /api/internal/data-management/retention/run-cleanup instead, which mounts
// ahead of authMiddleware so it can verify a Cloud Scheduler OIDC token.
dataManagementRouter.post('/retention/run-cleanup', async (req, res) => {
  const result = await retentionService.runRetentionCleanup();
  res.json(result);
});

// ============================================================================
// Data Export
// ============================================================================

// Create export job
// Per SE-004: Use authenticated user context instead of spoofable header
dataManagementRouter.post('/exports', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);

    const { tenantId, exportType, format, scope, filters } = req.body;

    if (!tenantId || !exportType || !format || !scope) {
      return res.status(400).json({
        error: 'tenantId, exportType, format, and scope are required',
      });
    }

    const job = await exportService.createExportJob({
      tenantId,
      requestedBy: userId,
      exportType,
      format,
      scope,
      filters,
    });

    res.status(201).json(job);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    throw error;
  }
});

// Get export job by ID
dataManagementRouter.get('/exports/:id', async (req, res) => {
  const job = await exportService.getExportJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Export job not found' });
  }
  res.json(job);
});

// Get export jobs for tenant
dataManagementRouter.get('/tenants/:tenantId/exports', async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
  const jobs = await exportService.getTenantExportJobs(req.params.tenantId, limit);
  res.json(jobs);
});

// Execute export job
dataManagementRouter.post('/exports/:id/execute', async (req, res) => {
  const job = await exportService.executeExport(req.params.id);
  res.json(job);
});

// Download export (logs the download)
// Per SE-004: Use authenticated user context instead of spoofable header
// Downloads require authentication - no anonymous downloads allowed
dataManagementRouter.get('/exports/:id/download', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const job = await exportService.getExportJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Export job not found' });
    }

    if (job.status !== 'completed' || !job.downloadUrl) {
      return res.status(400).json({ error: 'Export not ready for download' });
    }

    if (job.downloadExpiresAt && new Date() > job.downloadExpiresAt) {
      return res.status(410).json({ error: 'Download link has expired' });
    }

    // Log the download for compliance
    await exportService.logDownload(
      req.params.id,
      userId,
      req.ip || null
    );

    res.redirect(job.downloadUrl);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    throw error;
  }
});

// Process pending exports (called by Cloud Tasks)
dataManagementRouter.post('/exports/process-pending', async (req, res) => {
  const count = await exportService.processPendingExports();
  res.json({ processedCount: count });
});

// ============================================================================
// Data Deletion
// ============================================================================

// Create deletion request
// Per SE-004: Use authenticated user context instead of spoofable header
dataManagementRouter.post('/deletions', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);

    const { tenantId, deletionType, scope, reason, scheduledFor } = req.body;

    if (!tenantId || !deletionType || !scope || !reason) {
      return res.status(400).json({
        error: 'tenantId, deletionType, scope, and reason are required',
      });
    }

    const request = await deletionService.createDeletionRequest({
      tenantId,
      requestedBy: userId,
      deletionType,
      scope,
      reason,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
    });

    res.status(201).json(request);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    throw error;
  }
});

// Get deletion request by ID
dataManagementRouter.get('/deletions/:id', async (req, res) => {
  const request = await deletionService.getDeletionRequest(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Deletion request not found' });
  }
  res.json(request);
});

// Get deletion requests for tenant
dataManagementRouter.get('/tenants/:tenantId/deletions', async (req, res) => {
  const requests = await deletionService.getTenantDeletionRequests(req.params.tenantId);
  res.json(requests);
});

// Verify deletion request
dataManagementRouter.post('/deletions/:id/verify', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Verification token required' });
  }

  const request = await deletionService.verifyDeletion(req.params.id, token);

  if (!request) {
    return res.status(400).json({ error: 'Invalid or expired verification token' });
  }

  res.json(request);
});

// Execute deletion request
dataManagementRouter.post('/deletions/:id/execute', async (req, res) => {
  const request = await deletionService.executeDeletion(req.params.id);
  res.json(request);
});

// Cancel deletion request
dataManagementRouter.post('/deletions/:id/cancel', async (req, res) => {
  const request = await deletionService.cancelDeletionRequest(req.params.id);
  res.json(request);
});

// Process scheduled deletions (called by Cloud Scheduler)
dataManagementRouter.post('/deletions/process-scheduled', async (req, res) => {
  const count = await deletionService.processScheduledDeletions();
  res.json({ processedCount: count });
});
