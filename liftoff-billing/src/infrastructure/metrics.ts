// Cloud Monitoring custom metrics for liftoff-billing.
// Only writes metrics in non-test environments to avoid requiring GCP credentials locally.

import { loadConfig } from './config.js';

interface TimeSeriesPoint {
  metricType: string;
  value: number;
  labels?: Record<string, string>;
}

export async function writeCustomMetric(point: TimeSeriesPoint): Promise<void> {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'test') return;

  try {
    const { MetricServiceClient } = await import('@google-cloud/monitoring');
    const client = new MetricServiceClient();
    const projectName = `projects/${config.GCP_PROJECT_ID}`;
    const now = Date.now();

    await client.createTimeSeries({
      name: projectName,
      timeSeries: [
        {
          metric: {
            type: `custom.googleapis.com/${point.metricType}`,
            labels: point.labels ?? {},
          },
          resource: {
            type: 'global',
            labels: { project_id: config.GCP_PROJECT_ID },
          },
          points: [
            {
              interval: {
                endTime: { seconds: Math.floor(now / 1000) },
              },
              value: { doubleValue: point.value },
            },
          ],
        },
      ],
    });
  } catch (err) {
    // Metric emission is best-effort — never fail the request over it.
    console.error('[metrics] failed to write custom metric', point.metricType, err);
  }
}
