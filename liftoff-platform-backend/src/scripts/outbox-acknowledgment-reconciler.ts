// Cloud Run Job entry point. Triggered every 5 min by Cloud Scheduler.
//
// Pulls completed outbox rows in the 15min-24h freshness window, asks each
// tenant's tenant-runtime "did you process this event?", republishes via the
// existing publishEventWithExplicitId path when the subscriber says 'unknown'
// or 'failed', and emits Cloud Monitoring metrics for any row stuck > 24h
// with subscriber=unknown.
//
// Throttle: per-tenant fanout limited to 5 concurrent in-flight subscriber
// requests via pLimit (same pattern as the existing drift reconciler —
// src/internal-agents/reconciler.ts:21-32).

import pLimit from 'p-limit';
import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, closePools, withAdminScope } from '../infrastructure/database';
import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from '../connectors/tenant-runtime-url';
import { publishEventWithExplicitId } from '../events/publisher';
import { writeCustomMetric } from '../infrastructure/monitoring';
import { log } from '../infrastructure/logging';

const BATCH_LIMIT = 500;
const PER_TENANT_CONCURRENCY = 5;
const SUBSCRIBER_TIMEOUT_MS = 15_000;

// Hardcoded allowlist for the table name interpolated into the per-row UPDATE
// statement below. Values come from the UNION query — they are server-set
// literals — but we re-validate at runtime so any future code path that
// supplies a row from outside this script can never inject SQL.
const ALLOWED_OUTBOX_TABLES = new Set(['internal_agent_outbox', 'control_plane_outbox']);

interface OutboxRow {
  table: 'internal_agent_outbox' | 'control_plane_outbox';
  event_id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  entity_version: number | null;
  event_payload: Record<string, unknown>;
  completed_at: Date;
}

interface EventStatusResponse {
  /**
   * What the subscriber said about this event — except `unreachable`, which is
   * what WE say when it did not answer.
   *
   * `unknown` is a real answer from the runtime: the event is not in its ledger,
   * so it never processed it, so republishing is right. `unreachable` is the
   * absence of an answer, and it is evidence about nothing. Collapsing the two
   * — which this did, for every non-2xx — turns a refusal into a claim about
   * the ledger and makes the reconciler republish on it.
   *
   * For example, a tenant with agent execution disabled can have /event-status
   * answer 503 on every cycle; every event of theirs is then republished every
   * few minutes for 24 hours, then reported stuck.
   */
  status: 'processed' | 'failed' | 'processing' | 'unknown' | 'unreachable';
  error?: string;
  attempt_count?: number;
  completed_at?: string;
}

async function askSubscriber(tenantId: string, eventId: string): Promise<EventStatusResponse> {
  let baseUrl: string;
  try {
    baseUrl = await resolveRuntimeBaseUrl(tenantId);
  } catch (err) {
    log.warn({ tenantId, err: (err as Error).message }, 'resolveRuntimeBaseUrl failed');
    return { status: 'unreachable' };
  }
  const headers = await buildRuntimeHeaders(tenantId);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SUBSCRIBER_TIMEOUT_MS);
  try {
    // event_processing_ledger PK is (tenant_id, event_id) — both must be
    // supplied so the runtime can look up the exact row.
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/internal/event-status/${eventId}`);
    url.searchParams.set('tenant_id', tenantId);
    const r = await fetch(url.toString(), {
      headers,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      // 503 here is usually the runtime's kill switch, which gates on tenant
      // execution state and says nothing about the ledger.
      log.warn({ tenantId, eventId, status: r.status }, 'event-status non-2xx');
      return { status: 'unreachable' };
    }
    return (await r.json()) as EventStatusResponse;
  } catch (err) {
    log.warn({ tenantId, eventId, err: (err as Error).message }, 'event-status request failed');
    return { status: 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

async function processOne(row: OutboxRow): Promise<{
  republished: boolean;
  stuck24h: boolean;
  /** The runtime did not answer. Distinct from anything it could have said. */
  unreachable: boolean;
}> {
  // Defence in depth — the UPDATE below interpolates row.table as a literal
  // identifier (parameterised queries cannot bind table names). The UNION
  // query that produces these rows only sets `internal_agent_outbox` or
  // `control_plane_outbox`, but a future refactor must not be able to slip an
  // attacker-controlled value into this path.
  if (!ALLOWED_OUTBOX_TABLES.has(row.table)) {
    throw new Error(`outbox-ack-reconciler: refusing to UPDATE unknown table "${row.table}"`);
  }

  const status = await askSubscriber(row.tenant_id, row.event_id);
  const ageHours = (Date.now() - row.completed_at.getTime()) / 3600_000;
  const subStatus = status.status;

  await withAdminScope(
    { caller: 'outbox-ack-reconciler.mark', reason: 'record subscriber status' },
    (c) => c.query(
      `UPDATE ${row.table}
          SET reconciler_checked_at = NOW(),
              reconciler_subscriber_status = $3
        WHERE tenant_id = $1 AND event_id = $2`,
      [row.tenant_id, row.event_id, subStatus],
    ),
  );

  if (subStatus === 'processed' || subStatus === 'processing') {
    return { republished: false, stuck24h: false, unreachable: false };
  }

  // We never got an answer. Recorded (above) so it is visible, but neither
  // republished nor called stuck: republishing would act on a claim about the
  // ledger we never obtained, and `stuck24h` means the subscriber did not
  // process it in 24 hours — which we equally do not know. The row stays
  // unverified and will be asked again next tick, which is the honest state.
  if (subStatus === 'unreachable') {
    return { republished: false, stuck24h: false, unreachable: true };
  }

  // subStatus is 'unknown' or 'failed' — both are the subscriber's own answer.
  if (ageHours > 24) {
    return { republished: false, stuck24h: true, unreachable: false };
  }

  // Republish — same event_id, idempotent on subscriber side via ledger PK
  try {
    await publishEventWithExplicitId({
      eventId: row.event_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      eventType: row.event_type,
      entityVersion: row.entity_version,
      eventVersion: 1,
      tenantId: row.tenant_id,
      payload: row.event_payload,
    });
    return { republished: true, stuck24h: false, unreachable: false };
  } catch (err) {
    log.error({ event_id: row.event_id, err: (err as Error).message }, 'republish failed');
    return { republished: false, stuck24h: false, unreachable: false };
  }
}

export async function runOutboxAckReconciler(): Promise<{
  scanned: number;
  republished: number;
  stuck24h: number;
  /**
   * Rows whose subscriber never answered. Reported rather than acted on: an
   * unreachable runtime is an infrastructure fact about the TENANT, and a count
   * that only lives in this function would leave it looking like a quiet tick.
   */
  unreachable: number;
}> {
  const metricsProject = process.env.INTERNAL_AGENT_METRICS_PROJECT_ID ?? process.env.GCP_PROJECT_ID;

  const rows = await withAdminScope(
    { caller: 'outbox-ack-reconciler.fetch', reason: 'find unverified completed rows' },
    (c) => c.query<OutboxRow>(
      `(SELECT 'internal_agent_outbox'::text AS table, event_id::text, tenant_id::text,
               'internal_agent'::text AS entity_type, internal_agent_id::text AS entity_id,
               event_type, entity_version, event_payload, completed_at
          FROM internal_agent_outbox
         WHERE status = 'completed'
           AND tenant_id IS NOT NULL
           AND completed_at BETWEEN NOW() - INTERVAL '24 hours' AND NOW() - INTERVAL '15 minutes'
           AND (reconciler_checked_at IS NULL OR reconciler_checked_at < NOW() - INTERVAL '5 minutes'))
       UNION ALL
        (SELECT 'control_plane_outbox'::text, event_id::text, tenant_id::text,
                entity_type, entity_id::text, event_type, entity_version, event_payload, completed_at
           FROM control_plane_outbox
          WHERE status = 'completed'
            AND tenant_id IS NOT NULL
            AND completed_at BETWEEN NOW() - INTERVAL '24 hours' AND NOW() - INTERVAL '15 minutes'
            AND (reconciler_checked_at IS NULL OR reconciler_checked_at < NOW() - INTERVAL '5 minutes'))
        ORDER BY completed_at
        LIMIT $1`,
      [BATCH_LIMIT],
    ).then((r) => r.rows),
  );

  const perTenantLimits = new Map<string, ReturnType<typeof pLimit>>();
  const limitFor = (tenantId: string): ReturnType<typeof pLimit> => {
    let lim = perTenantLimits.get(tenantId);
    if (!lim) {
      lim = pLimit(PER_TENANT_CONCURRENCY);
      perTenantLimits.set(tenantId, lim);
    }
    return lim;
  };

  let republishedTotal = 0;
  let stuck24hTotal = 0;
  let unreachableTotal = 0;
  const perTenantRepublished = new Map<string, number>();
  const perTenantStuck = new Map<string, number>();
  const perTenantUnreachable = new Map<string, number>();

  await Promise.all(
    rows.map((row) => limitFor(row.tenant_id)(async () => {
      try {
        const r = await processOne(row);
        if (r.republished) {
          republishedTotal++;
          perTenantRepublished.set(row.tenant_id, (perTenantRepublished.get(row.tenant_id) ?? 0) + 1);
        }
        if (r.unreachable) {
          unreachableTotal++;
          perTenantUnreachable.set(row.tenant_id, (perTenantUnreachable.get(row.tenant_id) ?? 0) + 1);
        }
        if (r.stuck24h) {
          stuck24hTotal++;
          perTenantStuck.set(row.tenant_id, (perTenantStuck.get(row.tenant_id) ?? 0) + 1);
          log.error(
            { ...row, age_h: ((Date.now() - row.completed_at.getTime()) / 3600_000).toFixed(2) },
            'outbox row stuck > 24h with unknown/failed subscriber status',
          );
        }
      } catch (err) {
        // Per-row failure must not poison the batch. The ALLOWED_OUTBOX_TABLES
        // guard is the only place this throws today; log + continue so the
        // remaining rows still run their checks this tick.
        log.error(
          { event_id: row.event_id, table: row.table, err: (err as Error).message },
          'outbox-ack-reconciler: per-row processing failed',
        );
      }
    })),
  );

  // Per-tenant + global metrics. Same label-stability pattern as the existing
  // drift reconciler — see src/internal-agents/reconciler.ts:112-119.
  for (const [tenantId, count] of perTenantRepublished) {
    await writeCustomMetric({
      metricType: 'custom.googleapis.com/liftoff/outbox/republished_count',
      labels: { tenant_id: tenantId, scope: 'per_tenant' },
      value: count,
      projectId: metricsProject,
    });
  }
  await writeCustomMetric({
    metricType: 'custom.googleapis.com/liftoff/outbox/republished_count',
    labels: { tenant_id: '', scope: 'global' },
    value: republishedTotal,
    projectId: metricsProject,
  });

  for (const [tenantId, count] of perTenantStuck) {
    await writeCustomMetric({
      metricType: 'custom.googleapis.com/liftoff/outbox/stuck_24h_count',
      labels: { tenant_id: tenantId, scope: 'per_tenant' },
      value: count,
      projectId: metricsProject,
    });
  }
  await writeCustomMetric({
    metricType: 'custom.googleapis.com/liftoff/outbox/stuck_24h_count',
    labels: { tenant_id: '', scope: 'global' },
    value: stuck24hTotal,
    projectId: metricsProject,
  });

  // Per-tenant, because the number that matters is WHICH tenant's runtime could
  // not be reached — a global count cannot distinguish one dead runtime from a
  // scattering of transient timeouts.
  for (const [tenantId, count] of perTenantUnreachable) {
    await writeCustomMetric({
      metricType: 'custom.googleapis.com/liftoff/outbox/unreachable_count',
      labels: { tenant_id: tenantId, scope: 'per_tenant' },
      value: count,
      projectId: metricsProject,
    });
  }
  await writeCustomMetric({
    metricType: 'custom.googleapis.com/liftoff/outbox/unreachable_count',
    labels: { tenant_id: '', scope: 'global' },
    value: unreachableTotal,
    projectId: metricsProject,
  });

  log.info(
    {
      scanned: rows.length,
      republished: republishedTotal,
      stuck24h: stuck24hTotal,
      unreachable: unreachableTotal,
    },
    'outbox-ack-reconciler run complete',
  );
  return {
    scanned: rows.length,
    republished: republishedTotal,
    stuck24h: stuck24hTotal,
    unreachable: unreachableTotal,
  };
}

async function main(): Promise<void> {
  await initSecrets();
  await initDatabase();
  try {
    await runOutboxAckReconciler();
  } finally {
    await closePools();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'outbox-ack-reconciler crashed');
      process.exit(1);
    },
  );
}
