// Usage Ledger Service
// Per Section 1: Tenant runtime owns usage ledger
// Per Section 13: Tenant runtime owns usage events, action-credit ledger
// Per Section 20 Phase 4: Usage aggregation, forecast snapshots, operator visibility

import { Router } from 'express';
import { UsageLedgerService } from './service';
import { AggregationService } from './aggregation-service';
import { AggregationPeriod } from './aggregation-types';

export const usageLedgerRouter = Router();
const service = new UsageLedgerService();
const aggregationService = new AggregationService();

// Record usage event
usageLedgerRouter.post('/events', async (req, res) => {
  await service.recordUsage(req.body);
  res.status(201).json({ status: 'recorded' });
});

// Get current burn state
usageLedgerRouter.get('/burn/:tenantId', async (req, res) => {
  const burn = await service.getBurnState(req.params.tenantId);
  res.json(burn);
});

// Get remaining credits
usageLedgerRouter.get('/credits/:tenantId', async (req, res) => {
  const credits = await service.getRemainingCredits(req.params.tenantId);
  res.json(credits);
});

// Process refund/reversal
usageLedgerRouter.post('/refund', async (req, res) => {
  await service.processRefund(req.body);
  res.json({ status: 'refunded' });
});

// ============================================
// Per Section 20 Phase 4: Usage Aggregation APIs
// ============================================

// Run aggregation for a tenant
usageLedgerRouter.post('/aggregation/:tenantId/run', async (req, res) => {
  const { tenantId } = req.params;
  const { period, periodStart, periodEnd } = req.body;

  const snapshot = await aggregationService.runAggregation(
    tenantId,
    period as AggregationPeriod,
    new Date(periodStart),
    new Date(periodEnd)
  );

  res.json(snapshot);
});

// Run hourly aggregation
usageLedgerRouter.post('/aggregation/:tenantId/hourly', async (req, res) => {
  const snapshot = await aggregationService.runHourlyAggregation(req.params.tenantId);
  res.json(snapshot);
});

// Run daily aggregation
usageLedgerRouter.post('/aggregation/:tenantId/daily', async (req, res) => {
  const snapshot = await aggregationService.runDailyAggregation(req.params.tenantId);
  res.json(snapshot);
});

// Run scheduled aggregation for all tenants (called by Cloud Scheduler)
usageLedgerRouter.post('/aggregation/scheduled/:period', async (req, res) => {
  const { period } = req.params;
  await aggregationService.runScheduledAggregation(period as AggregationPeriod);
  res.json({ status: 'completed' });
});

// ============================================
// Per Section 20 Phase 4: Forecast APIs
// ============================================

// Generate forecast for a tenant
usageLedgerRouter.post('/forecast/:tenantId/generate', async (req, res) => {
  const forecast = await aggregationService.generateForecast(req.params.tenantId);
  res.json(forecast);
});

// ============================================
// Per Section 20 Phase 4: Operator Visibility APIs
// ============================================

// Get operator dashboard for a tenant
usageLedgerRouter.get('/dashboard/:tenantId', async (req, res) => {
  const dashboard = await aggregationService.getOperatorDashboard(req.params.tenantId);
  res.json(dashboard);
});
