// Stripe Meter Reconciliation Job
// Per Section 14: Stripe meter reconciliation

import { pool } from '../infrastructure/database';
import { StripeMeterClient } from '../infrastructure/stripe-meter';
import { logger } from '../infrastructure/logging';

interface ReconciliationReport {
  tenantId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  internalTotals: Record<string, number>;
  stripeTotals: Record<string, number>;
  deltas: Record<string, number>;
  missingEvents: number;
  status: 'ok' | 'discrepancy' | 'error';
  correctionApplied: boolean;
}

export class MeterReconciliationJob {
  private stripeMeter = new StripeMeterClient();

  // Per Section 14: The reconciliation job should:
  // - aggregate internal billable usage for the billing window
  // - fetch Stripe's processed meter totals
  // - compare deltas
  // - detect missing or delayed meter events
  // - replay or correct as needed
  // - produce an operator-visible reconciliation report before cycle close

  async run(billingPeriodStart: Date, billingPeriodEnd: Date): Promise<ReconciliationReport[]> {
    logger.info({
      message: 'Starting meter reconciliation job',
      billing_period_start: billingPeriodStart.toISOString(),
      billing_period_end: billingPeriodEnd.toISOString(),
    });

    const reports: ReconciliationReport[] = [];

    // Get all tenants with usage in this period
    const tenants = await this.getTenantsWithUsage(billingPeriodStart, billingPeriodEnd);

    for (const tenantId of tenants) {
      try {
        const report = await this.reconcileTenant(tenantId, billingPeriodStart, billingPeriodEnd);
        reports.push(report);

        // Per Section 14: Produce an operator-visible reconciliation report
        await this.saveReport(report);
      } catch (error) {
        logger.error({
          message: 'Failed to reconcile tenant',
          tenant_id: tenantId,
          error: (error as Error).message,
        });

        reports.push({
          tenantId,
          billingPeriodStart,
          billingPeriodEnd,
          internalTotals: {},
          stripeTotals: {},
          deltas: {},
          missingEvents: 0,
          status: 'error',
          correctionApplied: false,
        });
      }
    }

    logger.info({
      message: 'Meter reconciliation job complete',
      total_tenants: tenants.length,
      discrepancies: reports.filter(r => r.status === 'discrepancy').length,
      errors: reports.filter(r => r.status === 'error').length,
    });

    return reports;
  }

  private async reconcileTenant(
    tenantId: string,
    billingPeriodStart: Date,
    billingPeriodEnd: Date
  ): Promise<ReconciliationReport> {
    // Per Section 14: Aggregate internal billable usage for the billing window
    const internalTotals = await this.getInternalUsageTotals(
      tenantId,
      billingPeriodStart,
      billingPeriodEnd
    );

    // Per Section 14: Fetch Stripe's processed meter totals
    const stripeTotals = await this.stripeMeter.getMeterSummary(
      tenantId,
      billingPeriodStart,
      billingPeriodEnd
    );

    // Per Section 14: Compare deltas
    const deltas: Record<string, number> = {};
    let missingEvents = 0;

    const allEventTypes = new Set([
      ...Object.keys(internalTotals),
      ...Object.keys(stripeTotals),
    ]);

    for (const eventType of allEventTypes) {
      const internal = internalTotals[eventType] || 0;
      const stripe = stripeTotals[eventType] || 0;
      const delta = internal - stripe;

      deltas[eventType] = delta;

      if (delta > 0) {
        // Per Section 14: Detect missing or delayed meter events
        missingEvents += delta;
      }
    }

    const hasDiscrepancy = Object.values(deltas).some(d => Math.abs(d) > 0);
    let correctionApplied = false;

    // Per Section 14: Replay or correct as needed
    if (hasDiscrepancy && missingEvents > 0) {
      correctionApplied = await this.replayMissingEvents(
        tenantId,
        billingPeriodStart,
        billingPeriodEnd,
        deltas
      );
    }

    return {
      tenantId,
      billingPeriodStart,
      billingPeriodEnd,
      internalTotals,
      stripeTotals,
      deltas,
      missingEvents,
      status: hasDiscrepancy ? 'discrepancy' : 'ok',
      correctionApplied,
    };
  }

  private async getTenantsWithUsage(startTime: Date, endTime: Date): Promise<string[]> {
    const result = await pool.query(
      `SELECT DISTINCT tenant_id FROM usage_events
       WHERE created_at >= $1 AND created_at < $2`,
      [startTime, endTime]
    );
    return result.rows.map(r => r.tenant_id);
  }

  private async getInternalUsageTotals(
    tenantId: string,
    startTime: Date,
    endTime: Date
  ): Promise<Record<string, number>> {
    const result = await pool.query(
      `SELECT event_type, SUM(credits) as total
       FROM usage_events
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY event_type`,
      [tenantId, startTime, endTime]
    );

    const totals: Record<string, number> = {};
    for (const row of result.rows) {
      totals[row.event_type] = parseInt(row.total, 10);
    }
    return totals;
  }

  private async replayMissingEvents(
    tenantId: string,
    startTime: Date,
    endTime: Date,
    deltas: Record<string, number>
  ): Promise<boolean> {
    logger.info({
      message: 'Replaying missing meter events',
      tenant_id: tenantId,
      deltas,
    });

    // Find and replay events that may have failed to send to Stripe
    // This is a simplified implementation - in production, you'd want
    // to track which specific events failed and replay only those

    try {
      for (const [eventType, delta] of Object.entries(deltas)) {
        if (delta > 0) {
          // Create a correction meter event
          await this.stripeMeter.sendMeterEvent({
            tenantId,
            eventType,
            credits: delta,
            timestamp: new Date(),
            idempotencyKey: `correction-${tenantId}-${eventType}-${Date.now()}`,
          });
        }
      }
      return true;
    } catch (error) {
      logger.error({
        message: 'Failed to replay missing events',
        tenant_id: tenantId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  // Per Section 14: Produce an operator-visible reconciliation report before cycle close
  private async saveReport(report: ReconciliationReport): Promise<void> {
    await pool.query(
      `INSERT INTO reconciliation_reports
       (tenant_id, billing_period_start, billing_period_end, internal_totals,
        stripe_totals, deltas, missing_events, status, correction_applied)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        report.tenantId,
        report.billingPeriodStart,
        report.billingPeriodEnd,
        JSON.stringify(report.internalTotals),
        JSON.stringify(report.stripeTotals),
        JSON.stringify(report.deltas),
        report.missingEvents,
        report.status,
        report.correctionApplied,
      ]
    );
  }
}

// Entry point for Cloud Run job
export async function runReconciliationJob(): Promise<void> {
  const job = new MeterReconciliationJob();

  // Calculate billing period (previous month by default)
  const now = new Date();
  const billingPeriodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const billingPeriodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  await job.run(billingPeriodStart, billingPeriodEnd);
}
