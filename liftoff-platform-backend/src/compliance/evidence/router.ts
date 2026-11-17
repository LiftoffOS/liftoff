// Compliance Evidence Router
// Per Section 19/20: SOC 2 and GDPR readiness - compliance evidence collection
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router } from 'express';
import { ComplianceEvidenceService } from './service';
import { SOC2_CONTROLS } from './types';
import { getAuthenticatedUserId, isUnauthorizedError } from '../../infrastructure/auth-helpers';

export const evidenceRouter = Router();
const service = new ComplianceEvidenceService();

// Collect new evidence
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/evidence', async (req, res) => {
  try {
    const collectedBy = getAuthenticatedUserId(req);
    const {
      type,
      framework,
      controlId,
      title,
      description,
      artifactPath,
      metadata,
      expiresAt,
    } = req.body;

    const evidence = await service.collectEvidence({
      type,
      framework,
      controlId,
      title,
      description,
      collectedBy,
      artifactPath,
      metadata,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    res.status(201).json(evidence);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Get evidence by ID
evidenceRouter.get('/evidence/:id', async (req, res) => {
  const evidence = await service.getEvidence(req.params.id);
  if (!evidence) {
    return res.status(404).json({ error: 'Evidence not found' });
  }
  res.json(evidence);
});

// Get evidence by control
evidenceRouter.get('/evidence/control/:controlId', async (req, res) => {
  const framework = req.query.framework as string;
  const evidence = await service.getEvidenceByControl(
    req.params.controlId,
    framework as any
  );
  res.json(evidence);
});

// Review evidence
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/evidence/:id/review', async (req, res) => {
  try {
    const reviewedBy = getAuthenticatedUserId(req);
    const evidence = await service.reviewEvidence(req.params.id, reviewedBy);
    res.json(evidence);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Approve evidence
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/evidence/:id/approve', async (req, res) => {
  try {
    const approvedBy = getAuthenticatedUserId(req);
    const evidence = await service.approveEvidence(req.params.id, approvedBy);
    res.json(evidence);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Generate access review report
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/access-reviews', async (req, res) => {
  try {
    const reviewedBy = getAuthenticatedUserId(req);
    const { reviewPeriodStart, reviewPeriodEnd } = req.body;

    const report = await service.generateAccessReview({
      reviewPeriodStart: new Date(reviewPeriodStart),
      reviewPeriodEnd: new Date(reviewPeriodEnd),
      reviewedBy,
    });

    res.status(201).json(report);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Record a change
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/changes', async (req, res) => {
  try {
    const requestedBy = getAuthenticatedUserId(req);
    const {
      changeType,
      title,
      description,
      environment,
      riskLevel,
      rollbackPlan,
      testEvidence,
    } = req.body;

    const change = await service.recordChange({
      changeType,
      title,
      description,
      requestedBy,
      requestedAt: new Date(),
      environment,
      riskLevel,
      rollbackPlan,
      testEvidence,
      status: 'requested',
    });

    res.status(201).json(change);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Approve a change
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/changes/:id/approve', async (req, res) => {
  try {
    const approvedBy = getAuthenticatedUserId(req);
    const change = await service.approveChange(req.params.id, approvedBy);
    res.json(change);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Implement a change
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/changes/:id/implement', async (req, res) => {
  try {
    const implementedBy = getAuthenticatedUserId(req);
    const change = await service.implementChange(req.params.id, implementedBy);
    res.json(change);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Verify a change
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/changes/:id/verify', async (req, res) => {
  try {
    const verifiedBy = getAuthenticatedUserId(req);
    const change = await service.verifyChange(req.params.id, verifiedBy);
    res.json(change);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Add artifact to change
evidenceRouter.post('/changes/:id/artifacts', async (req, res) => {
  try {
    const { type, reference, url, hash } = req.body;

    await service.addChangeArtifact(req.params.id, { type, reference, url, hash });
    res.status(201).json({ added: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Generate audit package
// Per SE-004: Use authenticated user context instead of spoofable header
evidenceRouter.post('/audit-packages', async (req, res) => {
  try {
    const generatedBy = getAuthenticatedUserId(req);
    const { framework, periodStart, periodEnd } = req.body;

    const auditPackage = await service.generateAuditPackage({
      framework,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      generatedBy,
    });

    res.status(201).json(auditPackage);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Get audit package
evidenceRouter.get('/audit-packages/:id', async (req, res) => {
  const auditPackage = await service.getAuditPackage(req.params.id);
  if (!auditPackage) {
    return res.status(404).json({ error: 'Audit package not found' });
  }
  res.json(auditPackage);
});

// List audit packages
evidenceRouter.get('/audit-packages', async (req, res) => {
  const framework = req.query.framework as string;
  const packages = await service.listAuditPackages(framework as any);
  res.json(packages);
});

// Get SOC 2 controls reference
evidenceRouter.get('/controls/soc2', async (req, res) => {
  res.json(SOC2_CONTROLS);
});

// Get compliance dashboard stats
evidenceRouter.get('/dashboard', async (req, res) => {
  const framework = req.query.framework as string;
  const stats = await service.getDashboardStats(framework as any);
  res.json(stats);
});

// Process expired evidence (called by scheduler)
evidenceRouter.post('/process-expired', async (req, res) => {
  const count = await service.processExpiredEvidence();
  res.json({ processed: count });
});
