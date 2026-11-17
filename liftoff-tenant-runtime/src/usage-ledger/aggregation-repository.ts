// Usage Aggregation Repository
// Per Section 20 Phase 4: Usage aggregation, forecast snapshots

import { pool } from '../infrastructure/database';
import {
  UsageSnapshot,
  ForecastSnapshot,
  AggregationPeriod,
  AggregationJob,
} from './aggregation-types';
import { v4 as uuidv4 } from 'uuid';

export class AggregationRepository {
  // Save usage snapshot
  async saveSnapshot(snapshot: Omit<UsageSnapshot, 'id' | 'createdAt'>): Promise<UsageSnapshot> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO usage_snapshots (
        id, tenant_id, period, period_start, period_end,
        total_credits, total_actions, by_event_type, by_agent, by_connector
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, period, period_start)
      DO UPDATE SET
        total_credits = EXCLUDED.total_credits,
        total_actions = EXCLUDED.total_actions,
        by_event_type = EXCLUDED.by_event_type,
        by_agent = EXCLUDED.by_agent,
        by_connector = EXCLUDED.by_connector`,
      [
        id,
        snapshot.tenantId,
        snapshot.period,
        snapshot.periodStart,
        snapshot.periodEnd,
        snapshot.totalCredits,
        snapshot.totalActions,
        JSON.stringify(snapshot.byEventType),
        JSON.stringify(snapshot.byAgent),
        JSON.stringify(snapshot.byConnector),
      ]
    );

    return {
      id,
      ...snapshot,
      createdAt: new Date(),
    };
  }

  // Get snapshots for a tenant within a time range
  async getSnapshots(
    tenantId: string,
    period: AggregationPeriod,
    startDate: Date,
    endDate: Date
  ): Promise<UsageSnapshot[]> {
    const result = await pool.query(
      `SELECT * FROM usage_snapshots
       WHERE tenant_id = $1 AND period = $2
         AND period_start >= $3 AND period_end <= $4
       ORDER BY period_start ASC`,
      [tenantId, period, startDate, endDate]
    );

    return result.rows.map(this.mapSnapshotRow);
  }

  // Get latest snapshot for a tenant
  async getLatestSnapshot(tenantId: string, period: AggregationPeriod): Promise<UsageSnapshot | null> {
    const result = await pool.query(
      `SELECT * FROM usage_snapshots
       WHERE tenant_id = $1 AND period = $2
       ORDER BY period_start DESC LIMIT 1`,
      [tenantId, period]
    );

    return result.rows[0] ? this.mapSnapshotRow(result.rows[0]) : null;
  }

  // Save forecast snapshot
  async saveForecast(forecast: Omit<ForecastSnapshot, 'id' | 'createdAt'>): Promise<ForecastSnapshot> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO forecast_snapshots (
        id, tenant_id, forecast_date, period_end,
        projected_credits, projected_actions, confidence_interval,
        trend, trend_percentage, alerts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        forecast.tenantId,
        forecast.forecastDate,
        forecast.periodEnd,
        forecast.projectedCredits,
        forecast.projectedActions,
        JSON.stringify(forecast.confidenceInterval),
        forecast.trend,
        forecast.trendPercentage,
        JSON.stringify(forecast.alerts),
      ]
    );

    return {
      id,
      ...forecast,
      createdAt: new Date(),
    };
  }

  // Get latest forecast for a tenant
  async getLatestForecast(tenantId: string): Promise<ForecastSnapshot | null> {
    const result = await pool.query(
      `SELECT * FROM forecast_snapshots
       WHERE tenant_id = $1
       ORDER BY forecast_date DESC LIMIT 1`,
      [tenantId]
    );

    return result.rows[0] ? this.mapForecastRow(result.rows[0]) : null;
  }

  // Get forecasts for a tenant
  async getForecasts(tenantId: string, limit: number = 30): Promise<ForecastSnapshot[]> {
    const result = await pool.query(
      `SELECT * FROM forecast_snapshots
       WHERE tenant_id = $1
       ORDER BY forecast_date DESC
       LIMIT $2`,
      [tenantId, limit]
    );

    return result.rows.map(this.mapForecastRow);
  }

  // Aggregate usage events for a period
  async aggregateEvents(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{
    totalCredits: number;
    totalActions: number;
    byEventType: Record<string, number>;
    byAgent: Record<string, number>;
    byConnector: Record<string, number>;
  }> {
    // Get totals
    const totalsResult = await pool.query(
      `SELECT
         COALESCE(SUM(credits), 0) as total_credits,
         COUNT(*) as total_actions
       FROM usage_events
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, periodStart, periodEnd]
    );

    // Get by event type
    const byEventTypeResult = await pool.query(
      `SELECT event_type, SUM(credits) as credits
       FROM usage_events
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY event_type`,
      [tenantId, periodStart, periodEnd]
    );

    // Get by agent
    const byAgentResult = await pool.query(
      `SELECT agent_id, SUM(credits) as credits
       FROM usage_events
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY agent_id`,
      [tenantId, periodStart, periodEnd]
    );

    // Get by connector
    const byConnectorResult = await pool.query(
      `SELECT
         COALESCE(metadata->>'connector', 'unknown') as connector,
         SUM(credits) as credits
       FROM usage_events
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY metadata->>'connector'`,
      [tenantId, periodStart, periodEnd]
    );

    return {
      totalCredits: parseFloat(totalsResult.rows[0]?.total_credits) || 0,
      totalActions: parseInt(totalsResult.rows[0]?.total_actions) || 0,
      byEventType: Object.fromEntries(
        byEventTypeResult.rows.map(r => [r.event_type, parseFloat(r.credits)])
      ),
      byAgent: Object.fromEntries(
        byAgentResult.rows.map(r => [r.agent_id, parseFloat(r.credits)])
      ),
      byConnector: Object.fromEntries(
        byConnectorResult.rows.map(r => [r.connector, parseFloat(r.credits)])
      ),
    };
  }

  // Get hourly usage for trend analysis
  async getHourlyUsage(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ hour: Date; credits: number; actions: number }[]> {
    const result = await pool.query(
      `SELECT
         date_trunc('hour', created_at) as hour,
         SUM(credits) as credits,
         COUNT(*) as actions
       FROM usage_events
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY date_trunc('hour', created_at)
       ORDER BY hour ASC`,
      [tenantId, startDate, endDate]
    );

    return result.rows.map(r => ({
      hour: r.hour,
      credits: parseFloat(r.credits),
      actions: parseInt(r.actions),
    }));
  }

  // Create aggregation job
  async createJob(
    tenantId: string,
    period: AggregationPeriod,
    periodStart: Date,
    periodEnd: Date
  ): Promise<AggregationJob> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO aggregation_jobs (id, tenant_id, period, period_start, period_end, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, tenantId, period, periodStart, periodEnd]
    );

    return {
      id,
      tenantId,
      period,
      periodStart,
      periodEnd,
      status: 'pending',
      createdAt: new Date(),
    };
  }

  // Update job status
  async updateJobStatus(
    jobId: string,
    status: 'running' | 'completed' | 'failed',
    error?: string
  ): Promise<void> {
    await pool.query(
      `UPDATE aggregation_jobs
       SET status = $2, error = $3, completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE NULL END
       WHERE id = $1`,
      [jobId, status, error || null]
    );
  }

  // Get all active tenants for scheduled aggregation
  async getActiveTenants(): Promise<string[]> {
    const result = await pool.query(
      `SELECT DISTINCT tenant_id FROM burn_state
       WHERE remaining_credits > 0 OR used_credits > 0`
    );
    return result.rows.map(r => r.tenant_id);
  }

  private mapSnapshotRow(row: any): UsageSnapshot {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      period: row.period,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      totalCredits: parseFloat(row.total_credits),
      totalActions: parseInt(row.total_actions),
      byEventType: typeof row.by_event_type === 'string' ? JSON.parse(row.by_event_type) : row.by_event_type,
      byAgent: typeof row.by_agent === 'string' ? JSON.parse(row.by_agent) : row.by_agent,
      byConnector: typeof row.by_connector === 'string' ? JSON.parse(row.by_connector) : row.by_connector,
      createdAt: row.created_at,
    };
  }

  private mapForecastRow(row: any): ForecastSnapshot {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      forecastDate: row.forecast_date,
      periodEnd: row.period_end,
      projectedCredits: parseFloat(row.projected_credits),
      projectedActions: parseInt(row.projected_actions),
      confidenceInterval: typeof row.confidence_interval === 'string'
        ? JSON.parse(row.confidence_interval)
        : row.confidence_interval,
      trend: row.trend,
      trendPercentage: parseFloat(row.trend_percentage),
      alerts: typeof row.alerts === 'string' ? JSON.parse(row.alerts) : row.alerts,
      createdAt: row.created_at,
    };
  }
}
