// Warehouse connection-health reachability probe (implementation plan §4).
//
// Data-warehouse vendors push NO credential-revocation event, so connection
// health is probe-derived. This worker is the warehouse analog of
// token-keepalive.ts (which only covers rotating-OAuth connectors): on a
// schedule it runs a cheap read against each active native-warehouse connector
// and, on an auth/permission failure, flips connectors.status='error' — the
// signal the connections UI already renders as "Needs Reconnect". Transient
// failures (network / 5xx / rate-limit) leave status untouched and retry next
// cycle. The bound between a revoke and detection is the probe interval.
//
// The same probeWarehouseConnector() helper backs the connect-time verify-probe
// so both paths classify health identically.
//
// SCOPE: native warehouse connectors only (snowflake, databricks,
// google_bigquery). supabase is composio_managed — Composio owns its health,
// exactly as token-keepalive excludes composio_managed.

import type { Pool } from 'pg';
import { getPool, withTenantScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { runConnectorExecution } from '../rpc/execute-dispatcher.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';

/** Cheap, side-effect-free read used to prove a connector is reachable + authed. */
const WAREHOUSE_PROBES: Record<string, { functionName: string; input: Record<string, unknown> }> = {
  snowflake: { functionName: 'list_databases', input: {} },
  databricks: { functionName: 'run_query', input: { statement: 'SELECT 1' } },
  google_bigquery: { functionName: 'list_dataset_ids', input: {} },
};

export type ProbeOutcome = 'ok' | 'reconnect' | 'transient';

/** Auth/permission failures mean the grant is gone → reconnect. Everything else
 *  (network, 5xx, rate-limit, retryable) is transient → leave status alone. */
export function classifyProbeFailure(errorCode: string | undefined, message: string | undefined): ProbeOutcome {
  const code = (errorCode ?? '').toLowerCase();
  if (['permission_denied', 'unauthorized', 'authentication_failed', 'forbidden', 'invalid_credentials'].includes(code)) {
    return 'reconnect';
  }
  const m = (message ?? '').toLowerCase();
  if (/\b(401|403)\b|invalid[_ ]grant|unauthorized|forbidden|permission denied|access denied|revoked|token.*expired|expired.*token|invalid credential/.test(m)) {
    return 'reconnect';
  }
  return 'transient';
}

/**
 * Probe one warehouse connector. Returns the health outcome; does NOT mutate
 * status (callers decide). Reused by the worker and the connect-time verify.
 */
export async function probeWarehouseConnector(
  tenantId: string,
  connectorId: string,
  connectorType: string,
): Promise<{ outcome: ProbeOutcome; detail?: string }> {
  const probe = WAREHOUSE_PROBES[connectorType];
  if (!probe) return { outcome: 'ok' }; // non-probeable type — treat as healthy
  try {
    const resp = await runConnectorExecution({
      tenantId,
      connectorId,
      functionName: probe.functionName,
      input: probe.input as never,
      idempotencyKey: `reachability-${connectorId}`,
      traceId: `reachability-probe-${connectorId}`,
    });
    if (resp.success) return { outcome: 'ok' };
    return { outcome: classifyProbeFailure(resp.errorCode, resp.error), detail: resp.error };
  } catch (err) {
    // A thrown executor error (e.g. impersonation/JWT failure) — classify by message.
    const message = (err as Error).message;
    const status = (err as { httpStatus?: number }).httpStatus;
    const code = status === 401 || status === 403 ? 'permission_denied' : undefined;
    return { outcome: classifyProbeFailure(code, message), detail: message };
  }
}

export class WarehouseReachabilityProbe {
  private running = false;
  private current: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly pool: Pool,
    private readonly intervalMs: number,
    /** Only re-probe a connector this stale (SQL interval literal). */
    private readonly probeIntervalSql: string,
  ) {}

  start(): void { if (this.running) return; this.running = true; void this.loop(); }
  async stop(): Promise<void> { this.running = false; await this.current; }
  /** Run one cycle synchronously (tests / manual). Returns connectors probed. */
  async drain(): Promise<number> { return this.iterateOnce(); }

  private async loop(): Promise<void> {
    while (this.running) {
      this.current = this.iterateOnce().catch(() => 0);
      await this.current;
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  private async iterateOnce(): Promise<number> {
    const { rows } = await this.pool.query<{ tenant_id: string; connector_id: string; connector_type: string }>(
      `SELECT tenant_id, connector_id, connector_type
         FROM list_probeable_warehouse_connectors($1::interval)`,
      [this.probeIntervalSql],
    );
    let probed = 0;
    for (const r of rows) {
      const client = await this.pool.connect();
      let locked = false;
      try {
        const lk = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
          [r.connector_id],
        );
        locked = lk.rows[0]?.locked === true;
        if (!locked) continue; // another instance owns this connector this cycle
        await this.probeOne(r.tenant_id, r.connector_id, r.connector_type);
        probed++;
      } catch (err) {
        logger.warn({ connectorId: r.connector_id, err: (err as Error).message }, 'warehouse-reachability: cycle error');
      } finally {
        if (locked) {
          await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [r.connector_id]).catch(() => undefined);
        }
        client.release();
      }
    }
    if (probed > 0) logger.info({ probed, total: rows.length }, 'warehouse-reachability: cycle complete');
    return probed;
  }

  private async probeOne(tenantId: string, connectorId: string, connectorType: string): Promise<void> {
    const { outcome, detail } = await probeWarehouseConnector(tenantId, connectorId, connectorType);
    if (outcome === 'reconnect') {
      // Auth is gone → flip to 'error' via the SAME mechanism the OAuth path
      // uses; the connections page renders status='error' as "Needs Reconnect".
      await markConnectorReconnectRequired(tenantId, connectorId, connectorType);
    }
    await this.recordProbe(tenantId, connectorId, outcome === 'ok' ? null : (detail ?? outcome));
  }

  private async recordProbe(tenantId: string, connectorId: string, error: string | null): Promise<void> {
    await withTenantScope(tenantId, (c) =>
      c.query(
        `UPDATE connectors
            SET last_reachability_probe_at = now(),
                last_reachability_error = $2
          WHERE id = $1 AND tenant_id = $3`,
        [connectorId, error === null ? null : error.slice(0, 500), tenantId],
      ),
    );
  }
}

let probe: WarehouseReachabilityProbe | null = null;

export async function startWarehouseReachabilityProbe(): Promise<WarehouseReachabilityProbe> {
  if (probe) return probe;
  // Cycle every 30m; only re-probe connectors not checked in the last 30m. This
  // bounds revoke→detection at ~30m without hammering warehouses.
  probe = new WarehouseReachabilityProbe(await getPool(), 30 * 60 * 1000, '30 minutes');
  probe.start();
  return probe;
}

export async function stopWarehouseReachabilityProbe(): Promise<void> {
  if (probe) { await probe.stop(); probe = null; }
}
