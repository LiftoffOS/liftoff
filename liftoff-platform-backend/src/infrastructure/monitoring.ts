// Cloud Monitoring custom-metric writer. Used by the reconciler to emit
// drift_count (GAUGE) and drift_repaired_total (DELTA) time series.
//
// Authentication uses Application Default Credentials (the Cloud Run service
// account at runtime).

import { MetricServiceClient } from '@google-cloud/monitoring';
import { log } from './logging';

let client: MetricServiceClient | null = null;
function getClient(): MetricServiceClient {
  if (!client) client = new MetricServiceClient();
  return client;
}

export interface WriteCustomMetricInput {
  metricType: string;                                 // e.g. 'custom.googleapis.com/liftoff/internal_agents/drift_count'
  labels?: Record<string, string>;
  value: number;
  metricKind?: 'GAUGE' | 'CUMULATIVE' | 'DELTA';     // defaults to GAUGE
  valueType?: 'INT64' | 'DOUBLE';                     // defaults to INT64
  // Project to write the time series to. Defaults to GCP_PROJECT_ID. The
  // reconciler overrides this with INTERNAL_AGENT_METRICS_PROJECT_ID so
  // drift metrics land on the tenant-runtime project where the alert
  // policies and metric descriptors live (terraform/projects/
  // tenant-runtime-template/agent_creation_resilience.tf). Without it
  // emissions land on platform-control where no descriptor exists and
  // the SDK fails with monitoring.timeSeries.create PERMISSION_DENIED.
  projectId?: string;
}

export async function writeCustomMetric(input: WriteCustomMetricInput): Promise<void> {
  const projectId = input.projectId ?? process.env.GCP_PROJECT_ID;
  if (!projectId) {
    log.warn('writeCustomMetric: no projectId (input or GCP_PROJECT_ID), skipping');
    return;
  }
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const nowNanos = (now % 1000) * 1e6;
  const isDelta = input.metricKind === 'CUMULATIVE' || input.metricKind === 'DELTA';

  const request = {
    name: `projects/${projectId}`,
    timeSeries: [{
      metric: {
        type: input.metricType,
        labels: input.labels ?? {},
      },
      resource: {
        type: 'global',
        labels: { project_id: projectId },
      },
      points: [{
        interval: {
          endTime: { seconds: nowSeconds, nanos: nowNanos },
          ...(isDelta ? { startTime: { seconds: nowSeconds - 60, nanos: 0 } } : {}),
        },
        value: input.valueType === 'DOUBLE'
          ? { doubleValue: input.value }
          : { int64Value: String(input.value) },
      }],
    }],
  };

  try {
    // SDK accepts our point/interval shape but its type is union of many primitive
    // shapes — cast at the boundary.
    await getClient().createTimeSeries(request as Parameters<MetricServiceClient['createTimeSeries']>[0]);
  } catch (err) {
    // Don't fail the reconciler on metric-emission errors — observability, not
    // load-bearing.
    log.warn({ err: (err as Error).message, metricType: input.metricType }, 'writeCustomMetric: emission failed');
  }
}
