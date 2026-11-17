// Governance Write-Ahead Log — writer + drainer.
//
// Phase 3 durability guarantee: every tool-call audit record is written to
// the local `governance_wal` table BEFORE we attempt to call
// governance-engine's Record RPC. A background drainer replays unreplicated
// rows and marks them replicated once the RPC has acknowledged them.
//
// This protects against governance-engine outages: audit history is never
// lost, even if the service is down for minutes/hours at a time.

import { create } from '@bufbuild/protobuf';
import type { Pool } from 'pg';
import type { Client } from '@connectrpc/connect';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { GovernanceService, RecordRequest } from './governance-service-client';
import { RecordRequestSchema } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb.js';

export interface WalEntryInput {
  tenantId: string;
  agentId?: string | null;
  idempotencyKey: string;
  actionPayload: RecordRequest | Record<string, unknown>;
  result?: Record<string, unknown> | null;
  costUsd?: number | null;
  vendorLatencyMs?: number | null;
}

export interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

// Convert a RecordRequest-shaped object to a JSON-safe structure. The proto
// RecordRequest has a `payload: Uint8Array` field (external_response) which
// doesn't JSON-serialize cleanly; base64 it.
function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

/**
 * Write a WAL entry synchronously. Called BEFORE the governance-engine
 * Record RPC so that an RPC failure cannot lose audit data.
 *
 * ON CONFLICT does nothing — a retry with the same (tenant_id,
 * idempotency_key) is a no-op at the WAL level.
 */
export async function writeWalEntry(entry: WalEntryInput, pool?: Pool): Promise<void> {
  const p = pool ?? getPoolForService('default');
  const payloadJson = JSON.stringify(toJsonSafe(entry.actionPayload));
  const resultJson = entry.result == null ? null : JSON.stringify(toJsonSafe(entry.result));
  await p.query(
    `INSERT INTO governance_wal
       (tenant_id, agent_id, idempotency_key, action_payload, result, cost_usd, vendor_latency_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      entry.tenantId,
      entry.agentId ?? null,
      entry.idempotencyKey,
      payloadJson,
      resultJson,
      entry.costUsd ?? null,
      entry.vendorLatencyMs ?? null,
    ],
  );
}

interface WalRow {
  id: string;
  tenant_id: string;
  action_payload: Record<string, unknown>;
}

/**
 * Rebuild a RecordRequest from a JSON-serialized action_payload row.
 * Mirrors the mapping in toJsonSafe — bytes are base64 strings, bigints
 * are numeric strings.
 */
function rebuildRecordRequest(payload: Record<string, unknown>): RecordRequest {
  const externalResponse = typeof payload.externalResponse === 'string'
    ? Buffer.from(payload.externalResponse, 'base64')
    : new Uint8Array();
  const durationMs = payload.durationMs;
  const req = create(RecordRequestSchema, {
    preflightToken: String(payload.preflightToken ?? ''),
    idempotencyKey: String(payload.idempotencyKey ?? ''),
    connector: String(payload.connector ?? ''),
    entityType: String(payload.entityType ?? ''),
    actionType: String(payload.actionType ?? ''),
    targetRef: String(payload.targetRef ?? ''),
    traceId: String(payload.traceId ?? ''),
    durationMs: typeof durationMs === 'string' ? BigInt(durationMs) : BigInt(Number(durationMs ?? 0)),
    status: Number(payload.status ?? 0),
    error: String(payload.error ?? ''),
    costUsd: Number(payload.costUsd ?? 0),
    externalResponse,
  });
  // thread_id added in proto-gen 0.5.4 — assign after create to avoid
  // type error against the currently installed 0.3.x schema type.
  if (payload.threadId) {
    (req as Record<string, unknown>).threadId = String(payload.threadId);
  }
  return req;
}

/**
 * Drain up to `batchSize` unreplicated WAL rows to governance-engine.
 *
 * Strategy: select oldest-first, call Record in parallel (Record is idempotent
 * via idempotency_key), then mark rows replicated on success. Failures are
 * left in-place for the next drain pass.
 */
export async function drainWal(
  client: Client<typeof GovernanceService>,
  batchSize = 50,
  pool?: Pool,
): Promise<DrainResult> {
  const p = pool ?? getPoolForService('default');
  // SET LOCAL bypass — RLS policy requires app.tenant_id. The drainer is
  // cross-tenant by design, so we query as a superuser context. Our pool
  // runs with BYPASSRLS for service roles; if not, we'd need a
  // withAllTenantsScope wrapper. For now, rely on the tenant-runtime app
  // role having BYPASSRLS (set by the migration framework).
  const { rows } = await p.query<WalRow>(
    `SELECT id, tenant_id, action_payload
       FROM governance_wal
      WHERE NOT replicated
      ORDER BY created_at ASC
      LIMIT $1`,
    [batchSize],
  );

  if (rows.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    rows.map(async (row) => {
      const req = rebuildRecordRequest(row.action_payload);
      await client.record(req);
      return row.id;
    }),
  );

  const replicatedIds: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      replicatedIds.push(rows[i].id);
      succeeded += 1;
    } else {
      failed += 1;
      logger.warn(
        {
          event: 'governance_wal_drain_entry_failed',
          walId: rows[i].id,
          tenantId: rows[i].tenant_id,
          error: (r.reason as Error)?.message,
        },
        'governance_wal drain: Record RPC failed (will retry)',
      );
    }
  }

  if (replicatedIds.length > 0) {
    await p.query(
      `UPDATE governance_wal
          SET replicated = true, replicated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [replicatedIds],
    );
  }

  return { attempted: rows.length, succeeded, failed };
}
