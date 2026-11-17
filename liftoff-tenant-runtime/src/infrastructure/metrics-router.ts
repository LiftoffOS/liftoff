// Metrics Router
// Per Section 16: Custom metrics endpoints for alerting

import { Router } from 'express';
import { customMetricsService } from './custom-metrics';

export const metricsRouter = Router();

// Emit all custom metrics (called by Cloud Scheduler every minute)
metricsRouter.post('/emit', async (req, res) => {
  const metrics = await customMetricsService.emitAllMetrics();
  res.json(metrics);
});

// Get current metric values (for debugging/dashboard)
metricsRouter.get('/current', async (req, res) => {
  const metrics = await customMetricsService.emitAllMetrics();
  res.json(metrics);
});

// Check stuck workflows specifically
metricsRouter.get('/stuck-workflows', async (req, res) => {
  const count = await customMetricsService.emitStuckWorkflowsMetric();
  res.json({ stuckWorkflows: count });
});
