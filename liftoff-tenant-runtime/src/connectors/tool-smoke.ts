// C.2 — Per-tenant connector-tool smoke.
//
// Hourly Cloud Scheduler tick (see Terraform r5_scheduler_jobs.tf) hits
// /api/internal/connector-tool-smoke. For each (tenant, connector_manifest)
// where enabled=true, we:
//   1. Bucket the tenant via hash(tenant_id) % 6 — each run probes ONE
//      bucket, so a binding gets probed every 6 hours, not every hour.
//      Caps vendor calls at ~1/6 of the naive rate.
//   2. Pick a connector function whose categories include 'read', exclude
//      {write, destructive, outbound, sensitive}, and require no input
//      (probe-read-function.ts — shared with the daily binding probe). The
//      registry tag is the semantic guard that "no side effects".
//   3. Dispatch via toolGateway.execute with an empty payload, 10s timeout.
//   4. Per-vendor concurrency capped at 5 via an in-process semaphore so
//      we never have 5+ Gmail probes in flight at once across tenants.
//   5. Record outcome to connector_tool_smoke_results.
//
// Kill switch: CONNECTOR_TOOL_SMOKE_DISABLED=1 short-circuits the endpoint.

import crypto from 'crypto';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { scrubLogger } from '../observability/scrub-logger';
import { getToolSchemas as getConnectorFunctions } from './tool-schema-cache';
import { pickProbeReadFunction, isPayloadRejection, type ProbeCandidateFunction } from './probe-read-function';

const BUCKET_COUNT = 6;
const PER_VENDOR_CONCURRENCY = 5;
const SMOKE_DISPATCH_TIMEOUT_MS = 10_000;

// Smoke dispatch needs an agentId so connector-service can authorize
// the call. The convention is a dedicated maintenance agent per tenant
// whose UUID is configured via CONNECTOR_SMOKE_AGENT_ID. Falls back to
// SCHEDULED_INVOCATION_AGENT_ID (the same id other cron-originated
// dispatches use; see scheduled-invoke-handler.ts) and finally to a
// system-agent sentinel for unconfigured dev environments.
function resolveSmokeAgentId(): string {
  const env = process.env.CONNECTOR_SMOKE_AGENT_ID;
  if (env && /^[0-9a-f-]{36}$/i.test(env)) return env;
  const fallback = process.env.SCHEDULED_INVOCATION_AGENT_ID;
  if (fallback && /^[0-9a-f-]{36}$/i.test(fallback)) return fallback;
  return '00000000-0000-0000-0000-000000000005';
}

export interface SmokeRunSummary {
  bucket: number;
  probed: number;
  ok: number;
  failed: number;
  skipped_no_read_function: number;
  disabled: boolean;
}

interface BindingRow {
  id: string;
  tenant_id: string;
  connector_type: string;
}

/**
 * Picks which bucket runs THIS hour. We use UTC hour mod BUCKET_COUNT
 * which gives stable round-robin coverage — bucket N is hit at minute 0
 * of hour H where H % BUCKET_COUNT === N.
 */
export function currentBucket(now: Date = new Date()): number {
  return now.getUTCHours() % BUCKET_COUNT;
}

/** Stable bucket-id for a tenant. 6 buckets means each tenant gets probed
 *  once per 6-hour wall clock window. */
export function tenantBucket(tenantId: string): number {
  const h = crypto.createHash('sha256').update(tenantId).digest();
  // Use first 4 bytes as uint32, then mod into 6 buckets.
  const n = h.readUInt32BE(0);
  return n % BUCKET_COUNT;
}

/** Simple per-key semaphore. Each key has a fixed slot count; acquire()
 *  resolves when a slot is available. Used to cap concurrent probes per
 *  vendor across tenants. */
export class Semaphore {
  private slots: number;
  private waiters: Array<() => void> = [];
  constructor(slots: number) { this.slots = slots; }
  async acquire(): Promise<() => void> {
    if (this.slots > 0) {
      this.slots--;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.waiters.push(() => {
        this.slots--;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.slots++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

type ConnectorFunctionLike = ProbeCandidateFunction;

/** The read-only function the smoke can call with an empty payload, or null
 *  when the connector has none (write-only connectors like notification
 *  routers, connectors whose registry forgot to tag categories, or reads
 *  that all need an argument). */
export function pickReadOnlyAction(fns: ConnectorFunctionLike[] | null | undefined): ConnectorFunctionLike | null {
  return pickProbeReadFunction(fns);
}

interface ToolGatewayLike {
  execute(input: {
    tenantId: string;
    agentId: string;
    instructionVersion: number;
    traceId: string;
    idempotencyKey: string;
    connector: string;
    entityType: string;
    actionType: string;
    payload: Record<string, unknown>;
    estimatedCredits: number;
    _internalSkipHitl: boolean;
  }): Promise<{ success: boolean; error?: string; data?: unknown }>;
}

/** Run the smoke for THIS hour's bucket, or for every bucket when
 *  `allBuckets` is set. The daily housekeeping pass sets it: run once a day by
 *  hour, the same bucket would be probed every day and the other five never.
 *  Returns a summary so the endpoint can log it. */
export async function runConnectorToolSmoke(
  toolGateway: ToolGatewayLike,
  opts: { allBuckets?: boolean } = {},
): Promise<SmokeRunSummary> {
  const bucket = currentBucket();
  if (process.env.CONNECTOR_TOOL_SMOKE_DISABLED === '1') {
    return { bucket, probed: 0, ok: 0, failed: 0, skipped_no_read_function: 0, disabled: true };
  }

  const pool = getPool();
  // Pull every enabled binding; we filter by tenant bucket in JS rather
  // than SQL so the hashing logic stays in one place (also used by
  // dashboards if they ever want per-bucket views).
  const rows = await pool.query(`
    SELECT id, tenant_id, connector_type
    FROM connector_manifests
    WHERE enabled = true
  `);

  const inBucket = (rows.rows as BindingRow[]).filter(
    b => opts.allBuckets || tenantBucket(b.tenant_id) === bucket,
  );

  const semaphores = new Map<string, Semaphore>();
  function semaphoreFor(connectorType: string): Semaphore {
    let s = semaphores.get(connectorType);
    if (!s) { s = new Semaphore(PER_VENDOR_CONCURRENCY); semaphores.set(connectorType, s); }
    return s;
  }

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  await Promise.all(inBucket.map(async (binding) => {
    const fns = getConnectorFunctions(binding.connector_type) as unknown as ConnectorFunctionLike[];
    const action = pickReadOnlyAction(fns);
    if (!action) {
      skipped++;
      await recordResult({
        tenantId: binding.tenant_id,
        connectorManifestId: binding.id,
        action: '(no-read-function)',
        ok: false,
        errorCode: 'NO_READ_FUNCTION',
        errorMessage: `connector_type ${binding.connector_type} has no read-only function callable without input`,
        latencyMs: null,
      });
      return;
    }

    const release = await semaphoreFor(binding.connector_type).acquire();
    const start = Date.now();
    const smokeAgentId = resolveSmokeAgentId();
    try {
      const result = await withTimeout(
        toolGateway.execute({
          tenantId: binding.tenant_id,
          agentId: smokeAgentId,
          instructionVersion: 0,
          traceId: `smoke-${binding.id}-${Date.now()}`,
          idempotencyKey: `smoke-${binding.id}-${Date.now()}`,
          connector: binding.connector_type,
          entityType: 'default',
          actionType: action.name,
          payload: {},
          estimatedCredits: 1,
          _internalSkipHitl: true,
        }),
        SMOKE_DISPATCH_TIMEOUT_MS,
        'toolGateway.execute',
      );
      const latency = Date.now() - start;
      if (result.success) {
        ok++;
        await recordResult({
          tenantId: binding.tenant_id,
          connectorManifestId: binding.id,
          action: action.name,
          ok: true,
          errorCode: null,
          errorMessage: null,
          latencyMs: latency,
        });
      } else {
        failed++;
        const message = result.error ?? 'unknown';
        await recordResult({
          tenantId: binding.tenant_id,
          connectorManifestId: binding.id,
          action: action.name,
          ok: false,
          // A malformed-request answer is about the smoke's question (a
          // requirement the schema left unstated), not about the binding.
          errorCode: isPayloadRejection(message) ? 'PAYLOAD_REJECTED' : 'DISPATCH_ERROR',
          errorMessage: message.slice(0, 500),
          latencyMs: latency,
        });
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(message);
      await recordResult({
        tenantId: binding.tenant_id,
        connectorManifestId: binding.id,
        action: action.name,
        ok: false,
        errorCode: isTimeout ? 'TIMEOUT' : 'EXCEPTION',
        errorMessage: message.slice(0, 500),
        latencyMs: Date.now() - start,
      });
    } finally {
      release();
    }
  }));

  scrubLogger.info({
    event: 'connector_tool_smoke_run',
    bucket,
    probed: inBucket.length,
    ok,
    failed,
    skipped_no_read_function: skipped,
  });

  return { bucket, probed: inBucket.length, ok, failed, skipped_no_read_function: skipped, disabled: false };
}


async function recordResult(args: {
  tenantId: string;
  connectorManifestId: string;
  action: string;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO connector_tool_smoke_results
         (tenant_id, connector_manifest_id, action, ok, error_code, error_message, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        args.tenantId,
        args.connectorManifestId,
        args.action,
        args.ok,
        args.errorCode,
        args.errorMessage,
        args.latencyMs,
      ],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, manifestId: args.connectorManifestId },
      'connector-tool-smoke: result insert failed',
    );
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}
