// Usage Aggregation Service
// Per Section 20 Phase 4: Usage aggregation, forecast snapshots, operator visibility

import { AggregationRepository } from './aggregation-repository';
import { UsageLedgerRepository } from './repository';
import {
  UsageSnapshot,
  ForecastSnapshot,
  ForecastAlert,
  OperatorDashboard,
  TrendData,
  AggregationPeriod,
} from './aggregation-types';
import { logger } from '../infrastructure/logging';

export class AggregationService {
  private aggregationRepo = new AggregationRepository();
  private usageRepo = new UsageLedgerRepository();

  // Per Section 20 Phase 4: Build usage aggregation
  // Run aggregation for a specific period
  async runAggregation(
    tenantId: string,
    period: AggregationPeriod,
    periodStart: Date,
    periodEnd: Date
  ): Promise<UsageSnapshot> {
    const job = await this.aggregationRepo.createJob(tenantId, period, periodStart, periodEnd);

    try {
      await this.aggregationRepo.updateJobStatus(job.id, 'running');

      // Aggregate usage events
      const aggregated = await this.aggregationRepo.aggregateEvents(tenantId, periodStart, periodEnd);

      // Save snapshot
      const snapshot = await this.aggregationRepo.saveSnapshot({
        tenantId,
        period,
        periodStart,
        periodEnd,
        ...aggregated,
      });

      await this.aggregationRepo.updateJobStatus(job.id, 'completed');

      logger.info('Usage aggregation completed', {
        tenantId,
        period,
        totalCredits: snapshot.totalCredits,
        totalActions: snapshot.totalActions,
      });

      return snapshot;
    } catch (error) {
      await this.aggregationRepo.updateJobStatus(job.id, 'failed', (error as Error).message);
      logger.error('Usage aggregation failed', { error, tenantId, period });
      throw error;
    }
  }

  // Run hourly aggregation for a tenant
  async runHourlyAggregation(tenantId: string): Promise<UsageSnapshot> {
    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
    const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);

    return this.runAggregation(tenantId, 'hourly', periodStart, periodEnd);
  }

  // Run daily aggregation for a tenant
  async runDailyAggregation(tenantId: string): Promise<UsageSnapshot> {
    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

    return this.runAggregation(tenantId, 'daily', periodStart, periodEnd);
  }

  // Per Section 20 Phase 4: Build forecast snapshots
  async generateForecast(tenantId: string): Promise<ForecastSnapshot> {
    // Get burn state for billing period info
    const burnState = await this.usageRepo.getBurnState(tenantId);

    // Get historical daily snapshots for the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const snapshots = await this.aggregationRepo.getSnapshots(
      tenantId,
      'daily',
      thirtyDaysAgo,
      new Date()
    );

    // Calculate trend and projection
    const { trend, trendPercentage, projectedCredits, projectedActions, confidenceInterval } =
      this.calculateProjection(snapshots, burnState);

    // Generate alerts
    const alerts = this.generateAlerts(
      burnState,
      projectedCredits,
      trend,
      trendPercentage
    );

    // Save forecast
    const forecast = await this.aggregationRepo.saveForecast({
      tenantId,
      forecastDate: new Date(),
      periodEnd: burnState.billingPeriodEnd,
      projectedCredits,
      projectedActions,
      confidenceInterval,
      trend,
      trendPercentage,
      alerts,
    });

    logger.info('Forecast generated', {
      tenantId,
      projectedCredits,
      trend,
      alertCount: alerts.length,
    });

    return forecast;
  }

  // Per Section 20 Phase 4: Build operator visibility for burn and forecasts
  async getOperatorDashboard(tenantId: string): Promise<OperatorDashboard> {
    // Get current burn state
    const burnState = await this.usageRepo.getBurnState(tenantId);

    // Calculate burn rate (credits per hour over last 24 hours)
    const burnRate = await this.calculateBurnRate(tenantId);

    // Get latest forecast
    const forecast = await this.aggregationRepo.getLatestForecast(tenantId);

    // Calculate projected end of period usage
    const hoursRemaining = Math.max(
      0,
      (burnState.billingPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60)
    );
    const projectedEndOfPeriod = burnState.usedCredits + burnRate * hoursRemaining;

    // Get trend data
    const trends = await this.getTrendData(tenantId);

    // Get top agents and connectors
    const topAgents = await this.getTopAgents(tenantId);
    const topConnectors = await this.getTopConnectors(tenantId);

    // Combine all alerts
    const alerts = forecast?.alerts || [];

    // Add real-time alerts based on current state
    if (burnState.remainingCredits < burnState.includedCredits * 0.1) {
      alerts.push({
        type: 'approaching_limit',
        severity: 'warning',
        message: 'Less than 10% of included credits remaining',
        threshold: burnState.includedCredits * 0.1,
        projectedValue: burnState.remainingCredits,
      });
    }

    if (burnRate > 0 && projectedEndOfPeriod > burnState.includedCredits * 1.2) {
      alerts.push({
        type: 'exceeding_limit',
        severity: 'critical',
        message: 'Projected to exceed included credits by 20% or more',
        threshold: burnState.includedCredits,
        projectedValue: projectedEndOfPeriod,
      });
    }

    return {
      tenantId,
      currentBurn: {
        usedCredits: burnState.usedCredits,
        remainingCredits: burnState.remainingCredits,
        includedCredits: burnState.includedCredits,
        overageCredits: burnState.overageCredits,
        burnRate,
        projectedEndOfPeriod,
      },
      forecast,
      trends,
      topAgents,
      topConnectors,
      alerts,
    };
  }

  // Run scheduled aggregation for all active tenants
  async runScheduledAggregation(period: AggregationPeriod): Promise<void> {
    const tenants = await this.aggregationRepo.getActiveTenants();

    logger.info('Running scheduled aggregation', { period, tenantCount: tenants.length });

    for (const tenantId of tenants) {
      try {
        if (period === 'hourly') {
          await this.runHourlyAggregation(tenantId);
        } else if (period === 'daily') {
          await this.runDailyAggregation(tenantId);
          // Also generate forecast after daily aggregation
          await this.generateForecast(tenantId);
        }
      } catch (error) {
        logger.error('Scheduled aggregation failed for tenant', { error, tenantId, period });
      }
    }

    logger.info('Scheduled aggregation completed', { period, tenantCount: tenants.length });
  }

  private calculateProjection(
    snapshots: UsageSnapshot[],
    burnState: { billingPeriodEnd: Date; usedCredits: number; includedCredits: number }
  ): {
    trend: 'increasing' | 'stable' | 'decreasing';
    trendPercentage: number;
    projectedCredits: number;
    projectedActions: number;
    confidenceInterval: { low: number; high: number };
  } {
    if (snapshots.length < 3) {
      // Not enough data for meaningful projection
      return {
        trend: 'stable',
        trendPercentage: 0,
        projectedCredits: burnState.usedCredits,
        projectedActions: 0,
        confidenceInterval: { low: burnState.usedCredits, high: burnState.usedCredits },
      };
    }

    // Calculate average daily usage
    const dailyCredits = snapshots.map(s => s.totalCredits);
    const dailyActions = snapshots.map(s => s.totalActions);
    const avgDailyCredits = dailyCredits.reduce((a, b) => a + b, 0) / dailyCredits.length;
    const avgDailyActions = dailyActions.reduce((a, b) => a + b, 0) / dailyActions.length;

    // Calculate trend using simple linear regression
    const n = dailyCredits.length;
    const xSum = (n * (n - 1)) / 2;
    const xSqSum = (n * (n - 1) * (2 * n - 1)) / 6;
    const ySum = dailyCredits.reduce((a, b) => a + b, 0);
    const xySum = dailyCredits.reduce((sum, y, i) => sum + i * y, 0);

    const slope = (n * xySum - xSum * ySum) / (n * xSqSum - xSum * xSum);
    const trendPercentage = avgDailyCredits > 0 ? (slope / avgDailyCredits) * 100 : 0;

    let trend: 'increasing' | 'stable' | 'decreasing';
    if (trendPercentage > 5) {
      trend = 'increasing';
    } else if (trendPercentage < -5) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    // Project to end of billing period
    const daysRemaining = Math.max(
      0,
      (burnState.billingPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    const projectedAdditional = avgDailyCredits * daysRemaining;
    const projectedCredits = burnState.usedCredits + projectedAdditional;
    const projectedActions = Math.round(avgDailyActions * daysRemaining);

    // Calculate confidence interval using standard deviation
    const stdDev = Math.sqrt(
      dailyCredits.reduce((sum, x) => sum + Math.pow(x - avgDailyCredits, 2), 0) / n
    );
    const marginOfError = 1.96 * stdDev * Math.sqrt(daysRemaining); // 95% confidence

    return {
      trend,
      trendPercentage: Math.round(trendPercentage * 10) / 10,
      projectedCredits: Math.round(projectedCredits),
      projectedActions,
      confidenceInterval: {
        low: Math.round(projectedCredits - marginOfError),
        high: Math.round(projectedCredits + marginOfError),
      },
    };
  }

  private generateAlerts(
    burnState: { includedCredits: number; remainingCredits: number; usedCredits: number },
    projectedCredits: number,
    trend: string,
    trendPercentage: number
  ): ForecastAlert[] {
    const alerts: ForecastAlert[] = [];

    // Approaching limit alert
    if (projectedCredits > burnState.includedCredits * 0.8) {
      alerts.push({
        type: 'approaching_limit',
        severity: projectedCredits > burnState.includedCredits * 0.95 ? 'critical' : 'warning',
        message: `Projected to use ${Math.round((projectedCredits / burnState.includedCredits) * 100)}% of included credits`,
        threshold: burnState.includedCredits,
        projectedValue: projectedCredits,
      });
    }

    // Exceeding limit alert
    if (projectedCredits > burnState.includedCredits) {
      const overageAmount = projectedCredits - burnState.includedCredits;
      alerts.push({
        type: 'exceeding_limit',
        severity: 'critical',
        message: `Projected overage of ${Math.round(overageAmount)} credits`,
        threshold: burnState.includedCredits,
        projectedValue: projectedCredits,
      });
    }

    // Unusual trend alert
    if (Math.abs(trendPercentage) > 20) {
      alerts.push({
        type: 'trend_change',
        severity: 'warning',
        message: `Usage ${trend === 'increasing' ? 'increasing' : 'decreasing'} by ${Math.abs(trendPercentage)}% compared to historical average`,
      });
    }

    return alerts;
  }

  private async calculateBurnRate(tenantId: string): Promise<number> {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const hourlyUsage = await this.aggregationRepo.getHourlyUsage(tenantId, twentyFourHoursAgo, now);

    if (hourlyUsage.length === 0) {
      return 0;
    }

    const totalCredits = hourlyUsage.reduce((sum, h) => sum + h.credits, 0);
    return totalCredits / hourlyUsage.length;
  }

  private async getTrendData(tenantId: string): Promise<{
    last24Hours: TrendData;
    last7Days: TrendData;
    last30Days: TrendData;
  }> {
    const now = new Date();

    return {
      last24Hours: await this.calculateTrendForPeriod(
        tenantId,
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
        now,
        new Date(now.getTime() - 48 * 60 * 60 * 1000),
        new Date(now.getTime() - 24 * 60 * 60 * 1000)
      ),
      last7Days: await this.calculateTrendForPeriod(
        tenantId,
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        now,
        new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      ),
      last30Days: await this.calculateTrendForPeriod(
        tenantId,
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        now,
        new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      ),
    };
  }

  private async calculateTrendForPeriod(
    tenantId: string,
    currentStart: Date,
    currentEnd: Date,
    previousStart: Date,
    previousEnd: Date
  ): Promise<TrendData> {
    const [currentUsage, previousUsage] = await Promise.all([
      this.aggregationRepo.aggregateEvents(tenantId, currentStart, currentEnd),
      this.aggregationRepo.aggregateEvents(tenantId, previousStart, previousEnd),
    ]);

    const hourlyData = await this.aggregationRepo.getHourlyUsage(tenantId, currentStart, currentEnd);

    const hours = (currentEnd.getTime() - currentStart.getTime()) / (1000 * 60 * 60);
    const avgCreditsPerHour = hours > 0 ? currentUsage.totalCredits / hours : 0;

    const peakHour = hourlyData.length > 0
      ? hourlyData.reduce((max, h) => (h.credits > max.credits ? h : max), hourlyData[0])
      : null;

    const changeFromPrevious = previousUsage.totalCredits > 0
      ? ((currentUsage.totalCredits - previousUsage.totalCredits) / previousUsage.totalCredits) * 100
      : 0;

    return {
      totalCredits: currentUsage.totalCredits,
      totalActions: currentUsage.totalActions,
      averageCreditsPerHour: Math.round(avgCreditsPerHour * 100) / 100,
      peakHour: peakHour ? { hour: peakHour.hour.getHours(), credits: peakHour.credits } : null,
      changeFromPrevious: Math.round(changeFromPrevious * 10) / 10,
    };
  }

  private async getTopAgents(
    tenantId: string
  ): Promise<{ agentId: string; credits: number; percentage: number }[]> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const aggregated = await this.aggregationRepo.aggregateEvents(tenantId, thirtyDaysAgo, now);
    const total = aggregated.totalCredits;

    return Object.entries(aggregated.byAgent)
      .map(([agentId, credits]) => ({
        agentId,
        credits,
        percentage: total > 0 ? Math.round((credits / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5);
  }

  private async getTopConnectors(
    tenantId: string
  ): Promise<{ connector: string; credits: number; percentage: number }[]> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const aggregated = await this.aggregationRepo.aggregateEvents(tenantId, thirtyDaysAgo, now);
    const total = aggregated.totalCredits;

    return Object.entries(aggregated.byConnector)
      .map(([connector, credits]) => ({
        connector,
        credits,
        percentage: total > 0 ? Math.round((credits / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5);
  }
}

export const aggregationService = new AggregationService();
