// Optional Cloud Monitoring metrics export.
//
// The package doesn't hard-depend on @google-cloud/monitoring — the
// dependency is loaded lazily the first time a metric is recorded, so
// services that don't export metrics pay no cost. If the client can't be
// loaded (local dev, no ADC, etc.) metric emission silently skips.

import { getTraceContext } from './context.js';

export interface MetricsConfig {
  /** GCP project ID. Required — metrics can't be written without it. */
  projectId: string;
  /**
   * Resource type per https://cloud.google.com/monitoring/api/resources.
   * Default `global`.
   */
  resourceType?: string;
  /**
   * Labels attached to the MonitoredResource (not the metric). Use this
   * for service-identity labels (service_name, environment, ...).
   */
  resourceLabels?: Record<string, string>;
}

type MonitoringClientType = {
  createTimeSeries: (req: unknown) => Promise<unknown>;
  projectPath: (projectId: string) => string;
};

let cachedConfig: MetricsConfig | null = null;
let cachedClient: MonitoringClientType | null = null;
let clientLoadFailed = false;

export function configureMetrics(config: MetricsConfig): void {
  cachedConfig = { resourceType: 'global', resourceLabels: {}, ...config };
  // Reset cached client so next call reloads with new config
  cachedClient = null;
  clientLoadFailed = false;
}

function tryLoadClient(): MonitoringClientType | null {
  if (cachedClient) return cachedClient;
  if (clientLoadFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MetricServiceClient } = require('@google-cloud/monitoring');
    cachedClient = new MetricServiceClient() as MonitoringClientType;
    return cachedClient;
  } catch {
    clientLoadFailed = true;
    return null;
  }
}

/**
 * Record a custom metric value. Fire-and-forget — errors are swallowed.
 * The labels param is merged with the TraceContext (tenant_id, agent_id,
 * etc) so every metric gets correlation fields automatically.
 */
export function recordMetric(
  metricName: string,
  value: number,
  labels: Record<string, string> = {},
): void {
  if (!cachedConfig) return; // not configured = no-op
  const client = tryLoadClient();
  if (!client) return;

  const tctx = getTraceContext();
  const mergedLabels: Record<string, string> = {
    ...(tctx?.tenantId && { tenant_id: tctx.tenantId }),
    ...(tctx?.agentId && { agent_id: tctx.agentId }),
    ...labels,
  };

  const request = {
    name: client.projectPath(cachedConfig.projectId),
    timeSeries: [
      {
        metric: {
          type: `custom.googleapis.com/${metricName}`,
          labels: mergedLabels,
        },
        resource: {
          type: cachedConfig.resourceType,
          labels: cachedConfig.resourceLabels ?? {},
        },
        points: [
          {
            interval: {
              endTime: { seconds: Math.floor(Date.now() / 1000) },
            },
            value: { doubleValue: value },
          },
        ],
      },
    ],
  };

  // Fire-and-forget; suppress errors.
  void client.createTimeSeries(request).catch(() => {});
}
