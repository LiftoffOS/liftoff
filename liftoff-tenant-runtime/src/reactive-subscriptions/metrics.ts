// Cloud Monitoring custom metrics emitter for reactive subscriptions.
//
// Called from the subscription-router on a 60s interval and after each
// runComputedMetricPollingCycle invocation. Cloud Monitoring alert policies on
// these metrics extend the existing alerting Terraform pattern.

import { customMetricsService, CUSTOM_METRICS } from '../infrastructure/custom-metrics';

export async function emitSubscriptionMetrics(opts: {
  activeCount: number;
  matchedThisInterval: number;
  erroredCount: number;
  evalDurationP99Ms: number;
}): Promise<void> {
  const tasks = [
    customMetricsService.writeMetric({
      metricType: CUSTOM_METRICS.REACTIVE_SUBSCRIPTIONS_ACTIVE,
      value: opts.activeCount,
    }),
    customMetricsService.writeMetric({
      metricType: CUSTOM_METRICS.REACTIVE_SUBSCRIPTIONS_MATCHED,
      value: opts.matchedThisInterval,
    }),
    customMetricsService.writeMetric({
      metricType: CUSTOM_METRICS.REACTIVE_SUBSCRIPTIONS_ERRORED,
      value: opts.erroredCount,
    }),
    customMetricsService.writeMetric({
      metricType: CUSTOM_METRICS.REACTIVE_SUBSCRIPTIONS_EVAL_P99,
      value: opts.evalDurationP99Ms,
    }),
  ];
  await Promise.allSettled(tasks);
}
