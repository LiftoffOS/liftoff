// Layer D: compares the most recent reconciler-emitted vs auditor-emitted
// values for the same tenant + kind (paused / missing / failing). Emits a
// single agent_scheduler/disagreement_count metric so a standard threshold
// alert can fire on disagreement without MQL.
//
// Runs once a day from the housekeeping pass, after the auditor.
//
// Window sizing: the auditor (Layer B) and the reconciler (Layer A) each emit
// once a day now. To pair them per (tenant, kind), the read window must be
// wider than the slowest cadence: 25 h, so every run sees the latest sample of
// both. (A window narrower than the cadence leaves stretches where
// disagreement_count cannot be computed at all, which is how a 15-min window
// once broke the alert.)

import { MetricServiceClient, protos } from '@google-cloud/monitoring';
import { log } from '../infrastructure/logging';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'YOUR_CONTROL_PROJECT';
const METRIC_PREFIX = 'custom.googleapis.com/agent_scheduler';
const READ_WINDOW_SECONDS = 25 * 60 * 60; // 25 h — wider than the auditor's daily cadence (housekeeping)

const metricClient = new MetricServiceClient();

interface Sample {
  tenantId: string;
  source: 'reconciler' | 'auditor';
  value: number;
}

async function fetchRecent(kind: 'paused' | 'missing' | 'failing'): Promise<Sample[]> {
  const endTime = { seconds: Math.floor(Date.now() / 1000) };
  const startTime = { seconds: endTime.seconds - READ_WINDOW_SECONDS };
  const [series] = await metricClient.listTimeSeries({
    name: `projects/${PROJECT_ID}`,
    filter: `metric.type = "${METRIC_PREFIX}/${kind}_count"`,
    interval: { startTime, endTime },
    view: protos.google.monitoring.v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
  });

  const out: Sample[] = [];
  for (const ts of series) {
    const tenantId = ts.metric?.labels?.tenant_id;
    const source = ts.metric?.labels?.source as 'reconciler' | 'auditor' | undefined;
    if (!tenantId || !source) continue;
    const latestPoint = ts.points?.[0]; // points sorted descending by time
    const value = Number(latestPoint?.value?.int64Value ?? '0');
    out.push({ tenantId, source, value });
  }
  return out;
}

async function emitDisagreements(): Promise<void> {
  // We emit one metric per (tenant, kind) regardless of whether both sources
  // observed the tenant. For tenants where only ONE source emitted a sample
  // in the window, we still emit `0` (treat absence as "no disagreement
  // observable") rather than skipping. Skipping would leave the metric
  // missing and break the threshold alert's `duration` semantics — the alert
  // requires a continuous stream of samples, not gappy ones.
  //
  // The "asymmetric absence" case (e.g. reconciler reports 5, auditor reports
  // nothing) is emitted as `source_absent_count` below. It was previously
  // claimed to be "visible separately via the Layer C absence alert on the
  // missing source's metric" — it was not: Layer C filters
  // metric.labels.source="reconciler" and so watches only one of the two
  // sources. Nothing watched the auditor, and Layer D reported agreement
  // throughout. Layer D's job is still "do both sources AGREE when both are
  // present"; `source_absent_count` answers "are both sources present", which
  // no layer answered before.
  const allDiffs: Array<{ tenantId: string; kind: string; diff: number }> = [];
  // Counted per (kind, source) and emitted below. Absence used to vanish into
  // `diff = 0`, which is indistinguishable from a genuine agreement, so Layer D
  // published an unbroken stream of zeros — a positive "both sources agree" —
  // for the whole time the auditor was dead and writing nothing at all. The
  // diff semantics below are unchanged and still correct; what was missing is
  // that a comparison which could not be made now says so.
  const absent: Array<{ kind: string; source: 'reconciler' | 'auditor'; count: number }> = [];

  for (const kind of ['paused', 'missing', 'failing'] as const) {
    const samples = await fetchRecent(kind);
    const byTenant = new Map<string, { reconciler?: number; auditor?: number }>();
    for (const s of samples) {
      const cur = byTenant.get(s.tenantId) ?? {};
      cur[s.source] = s.value;
      byTenant.set(s.tenantId, cur);
    }
    let reconcilerAbsent = 0;
    let auditorAbsent = 0;
    for (const [tenantId, { reconciler, auditor }] of byTenant) {
      if (reconciler === undefined) reconcilerAbsent++;
      if (auditor === undefined) auditorAbsent++;
      const diff = reconciler !== undefined && auditor !== undefined
        ? Math.abs(reconciler - auditor)
        : 0;
      allDiffs.push({ tenantId, kind, diff });
    }
    absent.push({ kind, source: 'reconciler', count: reconcilerAbsent });
    absent.push({ kind, source: 'auditor', count: auditorAbsent });
  }

  // Emit one metric per (tenant, kind) showing the absolute disagreement,
  // plus one per (kind, source) counting tenants that source failed to report.
  const now = { seconds: Math.floor(Date.now() / 1000) };
  const series = [
    ...allDiffs.map((d) => ({
      metric: {
        type: `${METRIC_PREFIX}/disagreement_count`,
        labels: { tenant_id: d.tenantId, kind: d.kind },
      },
      resource: { type: 'global', labels: { project_id: PROJECT_ID } },
      points: [{ interval: { endTime: now }, value: { int64Value: String(d.diff) } }],
    })),
    ...absent.map((a) => ({
      metric: {
        type: `${METRIC_PREFIX}/source_absent_count`,
        labels: { kind: a.kind, source: a.source },
      },
      resource: { type: 'global', labels: { project_id: PROJECT_ID } },
      points: [{ interval: { endTime: now }, value: { int64Value: String(a.count) } }],
    })),
  ];

  // Chunk to 150 per request (createTimeSeries limit is 200).
  const CHUNK = 150;
  for (let i = 0; i < series.length; i += CHUNK) {
    await metricClient.createTimeSeries({
      name: `projects/${PROJECT_ID}`,
      timeSeries: series.slice(i, i + CHUNK) as never,
    });
  }

  log.info({
    pairs_compared: allDiffs.length,
    absent: absent.filter((a) => a.count > 0),
  }, 'disagreement-emitter done');
}

emitDisagreements().catch((err) => {
  log.error({ err: (err as Error).message }, 'disagreement-emitter failed');
  process.exit(1);
});
