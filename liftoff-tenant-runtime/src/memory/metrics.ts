// src/memory/metrics.ts
//
// Lightweight in-process counters/histograms for memory-system observability.
// Two channels:
//
//   1. Structured log line per increment — picked up by Cloud Logging
//      log-based metrics. Cheap, fire-and-forget, ordered by timestamp.
//   2. Periodic flush to Cloud Monitoring (custom.googleapis.com/liftoff/memory/*)
//      via the existing CustomMetricsService pattern. Reduces per-event API cost
//      vs writing one time series point per increment.
//
// Plans E.5, B.10, C.7 enumerate the metrics this module emits.

import { log } from '../infrastructure/logging';
import { normalizeMetricLabels } from './metric-labels';

type LabelMap = Record<string, string | number>;

interface CounterEntry {
  value: number;
  labels: LabelMap;
}

interface HistogramEntry {
  count: number;
  sum: number;
  buckets: Map<number, number>;
  labels: LabelMap;
}

// Process-local accumulators. Keyed by `${name}|${JSON.stringify(labels)}`.
const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();

const DEFAULT_BUCKETS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1.0];
const SIZE_BUCKETS = [1, 3, 5, 10, 15, 30, 60, 120];

function keyFor(name: string, labels: LabelMap): string {
  const sorted = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',');
  return `${name}|${sorted}`;
}

export function incCounter(name: string, rawLabels: LabelMap = {}, value = 1): void {
  // Reduce to the declared label set BEFORE keying the accumulator — the map
  // below is process-local and never evicted, so an undeclared per-tenant label
  // would grow it for the life of the instance.
  const labels = normalizeMetricLabels(name, rawLabels);
  const key = keyFor(name, labels);
  const existing = counters.get(key);
  if (existing) {
    existing.value += value;
  } else {
    counters.set(key, { value, labels });
  }
  // Structured log line for log-based metric extraction. metric_name + metric_value
  // are the conventional fields the Cloud Logging extractor reads.
  log.info({ metric_type: 'counter', metric_name: name, metric_value: value, ...labels }, `metric:${name}`);
}

export function observeHistogram(
  name: string,
  value: number,
  rawLabels: LabelMap = {},
  buckets: number[] = DEFAULT_BUCKETS,
): void {
  // Same reduction as incCounter, same reason.
  const labels = normalizeMetricLabels(name, rawLabels);
  const key = keyFor(name, labels);
  let entry = histograms.get(key);
  if (!entry) {
    entry = { count: 0, sum: 0, buckets: new Map(buckets.map(b => [b, 0])), labels };
    histograms.set(key, entry);
  }
  entry.count += 1;
  entry.sum += value;
  for (const b of buckets) {
    if (value <= b) entry.buckets.set(b, (entry.buckets.get(b) ?? 0) + 1);
  }
  log.info({ metric_type: 'histogram', metric_name: name, metric_value: value, ...labels }, `metric:${name}`);
}

export function setGauge(name: string, value: number, rawLabels: LabelMap = {}): void {
  // A gauge keeps no accumulator, so it cannot leak memory the way the two above
  // can — but it is read by the same log-based metric extractors, and a label
  // that explodes a metric's series count is just as unusable there. One emit
  // surface left ungoverned is the one somebody adds the next leak to.
  const labels = normalizeMetricLabels(name, rawLabels);
  log.info({ metric_type: 'gauge', metric_name: name, metric_value: value, ...labels }, `metric:${name}`);
}

// Periodic flush helper — invoked by a cron loop or a /api/tasks endpoint.
// Reads the in-process accumulators, writes one Cloud Monitoring point per
// (name, labels) pair, then resets counters/histograms.
export async function flushMemoryMetrics(): Promise<{ countersFlushed: number; histogramsFlushed: number }> {
  let countersFlushed = 0;
  let histogramsFlushed = 0;
  try {
    const { customMetricsService } = await import('../infrastructure/custom-metrics');
    for (const [, entry] of counters) {
      await customMetricsService.writeMetric({
        metricType: `custom.googleapis.com/liftoff/memory/${(entry.labels.__name ?? 'counter') as string}`,
        value: entry.value,
        labels: Object.fromEntries(Object.entries(entry.labels).filter(([k]) => k !== '__name').map(([k, v]) => [k, String(v)])),
      }).catch(err => log.warn({ err: err.message }, 'memory metric flush failed (non-fatal)'));
      countersFlushed++;
    }
    counters.clear();

    for (const [, entry] of histograms) {
      await customMetricsService.writeMetric({
        metricType: `custom.googleapis.com/liftoff/memory/${(entry.labels.__name ?? 'histogram') as string}_count`,
        value: entry.count,
        labels: Object.fromEntries(Object.entries(entry.labels).filter(([k]) => k !== '__name').map(([k, v]) => [k, String(v)])),
      }).catch(err => log.warn({ err: err.message }, 'memory metric flush failed (non-fatal)'));
      histogramsFlushed++;
    }
    histograms.clear();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'flushMemoryMetrics: aborting (non-fatal)');
  }
  return { countersFlushed, histogramsFlushed };
}

// Re-export bucket constants so callers can choose a domain-appropriate set.
export const HISTOGRAM_BUCKETS = {
  DEFAULT: DEFAULT_BUCKETS,
  SIZE: SIZE_BUCKETS,
};
