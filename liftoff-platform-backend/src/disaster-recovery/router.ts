// Disaster Recovery Router
// Per Section 17: DR, restore, and reconcile
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router } from 'express';
import { RestoreDrillService } from './restore-drill';
import { getAuthenticatedUserId, isUnauthorizedError } from '../infrastructure/auth-helpers';

export const disasterRecoveryRouter = Router();
const service = new RestoreDrillService();

// Schedule a new restore drill
// Per SE-004: Use authenticated user context instead of spoofable header
disasterRecoveryRouter.post('/drills', async (req, res) => {
  try {
    const createdBy = getAuthenticatedUserId(req);
    const { drillType, environment, sourceBackupId, sourceTimestamp } = req.body;

    if (!drillType || !environment) {
      return res.status(400).json({ error: 'drillType and environment required' });
    }

    if (!['staging', 'development'].includes(environment)) {
      return res.status(400).json({ error: 'Drills can only run in staging or development' });
    }

    const drill = await service.scheduleDrill({
      drillType,
      environment,
      sourceBackupId,
      sourceTimestamp: sourceTimestamp ? new Date(sourceTimestamp) : undefined,
      createdBy,
    });

    res.status(201).json(drill);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Execute a scheduled drill
disasterRecoveryRouter.post('/drills/:id/execute', async (req, res) => {
  try {
    const drill = await service.executeDrill(req.params.id);
    res.json(drill);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get drill by ID
disasterRecoveryRouter.get('/drills/:id', async (req, res) => {
  const drill = await service.getDrill(req.params.id);
  if (!drill) {
    return res.status(404).json({ error: 'Restore drill not found' });
  }
  res.json(drill);
});

// Get drill history
disasterRecoveryRouter.get('/drills', async (req, res) => {
  const { environment, status, limit } = req.query;

  const drills = await service.getDrillHistory({
    environment: environment as string,
    status: status as any,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json(drills);
});

// Get last successful drill for environment
disasterRecoveryRouter.get('/drills/last-successful/:environment', async (req, res) => {
  const drill = await service.getLastSuccessfulDrill(req.params.environment);
  if (!drill) {
    return res.json({ lastDrill: null, overdue: true });
  }

  const overdue = await service.isDrillOverdue(req.params.environment);
  res.json({ lastDrill: drill, overdue });
});

// Check if drill is overdue
disasterRecoveryRouter.get('/drills/overdue/:environment', async (req, res) => {
  const overdue = await service.isDrillOverdue(req.params.environment);
  res.json({ overdue });
});

// Get RTO/RPO tier documentation
disasterRecoveryRouter.get('/rto-rpo-tiers', async (req, res) => {
  const tiers = service.getRTORPOTiers();
  res.json(tiers);
});

// Scheduled job endpoint (called by Cloud Scheduler)
disasterRecoveryRouter.post('/scheduled/quarterly-drill', async (req, res) => {
  try {
    // Check if drill is needed
    const overdue = await service.isDrillOverdue('staging');
    if (!overdue) {
      return res.json({ scheduled: false, reason: 'Recent drill exists' });
    }

    // Schedule a new drill
    const drill = await service.scheduleDrill({
      drillType: 'full',
      environment: 'staging',
      createdBy: 'cloud-scheduler',
    });

    // Execute immediately
    const executedDrill = await service.executeDrill(drill.id);

    res.json({
      scheduled: true,
      drillId: executedDrill.id,
      status: executedDrill.status,
      results: executedDrill.results,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
