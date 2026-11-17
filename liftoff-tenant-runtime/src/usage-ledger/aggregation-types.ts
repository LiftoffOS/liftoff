// Usage Aggregation Types
// Per Section 20 Phase 4: Usage aggregation, forecast snapshots, operator visibility

export type AggregationPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface UsageSnapshot {
  id: string;
  tenantId: string;
  period: AggregationPeriod;
  periodStart: Date;
  periodEnd: Date;
  totalCredits: number;
  totalActions: number;
  byEventType: Record<string, number>;
  byAgent: Record<string, number>;
  byConnector: Record<string, number>;
  createdAt: Date;
}

export interface ForecastSnapshot {
  id: string;
  tenantId: string;
  forecastDate: Date;
  periodEnd: Date; // End of billing period being forecasted
  projectedCredits: number;
  projectedActions: number;
  confidenceInterval: {
    low: number;
    high: number;
  };
  trend: 'increasing' | 'stable' | 'decreasing';
  trendPercentage: number; // e.g., +15% or -5%
  alerts: ForecastAlert[];
  createdAt: Date;
}

export interface ForecastAlert {
  type: 'approaching_limit' | 'exceeding_limit' | 'unusual_spike' | 'trend_change';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  threshold?: number;
  projectedValue?: number;
}

export interface OperatorDashboard {
  tenantId: string;
  currentBurn: {
    usedCredits: number;
    remainingCredits: number;
    includedCredits: number;
    overageCredits: number;
    burnRate: number; // credits per hour
    projectedEndOfPeriod: number;
  };
  forecast: ForecastSnapshot | null;
  trends: {
    last24Hours: TrendData;
    last7Days: TrendData;
    last30Days: TrendData;
  };
  topAgents: { agentId: string; credits: number; percentage: number }[];
  topConnectors: { connector: string; credits: number; percentage: number }[];
  alerts: ForecastAlert[];
}

export interface TrendData {
  totalCredits: number;
  totalActions: number;
  averageCreditsPerHour: number;
  peakHour: { hour: number; credits: number } | null;
  changeFromPrevious: number; // percentage change
}

export interface AggregationJob {
  id: string;
  tenantId: string;
  period: AggregationPeriod;
  periodStart: Date;
  periodEnd: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}
