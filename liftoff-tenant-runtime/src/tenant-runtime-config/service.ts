// Part 3 — tenant_runtime_config resolver.
//
// Reads per-tenant runtime knobs (delegation caps, trajectory sink gates)
// from the tenant_runtime_config table (migration 290) with a 60s in-memory
// LRU cache. Cache invalidation rides on the
// tenant-runtime-config-updated-${env} Pub/Sub topic (see
// src/events/tenant-runtime-config-subscriber.ts).

import { LruCache } from '../infrastructure/lru-cache';
import { getPoolForService } from '../infrastructure/database';

export interface TenantRuntimeConfig {
  maxDelegationDepth: number | null;
  maxDelegationFanout: number | null;
  defaultMaxConcurrentChildren: number | null;
  /** Cap on concurrently-running delegated children of ONE agent, across every
   *  caller in the workspace (migration 367). Distinct from
   *  defaultMaxConcurrentChildren, which bounds one fan-out call. Delegated
   *  children bypass the per-agent execution lock, so this is the bound that
   *  replaces it. NULL = in-code default. */
  maxChildrenPerAgent: number | null;
  maxHitlBeforeInterrupt: number | null;
  reawaitInFlightDeadlineMs: number | null;
  trajectorySinkEnabled: boolean;
  trajectorySinkMaxBytes: number | null;
  trajectoryCaptureNestedCodeSessions: boolean;
}

interface TenantRuntimeConfigRow {
  max_delegation_depth: number | null;
  max_delegation_fanout: number | null;
  default_max_concurrent_children: number | null;
  max_children_per_agent: number | null;
  max_hitl_before_interrupt: number | null;
  reawait_in_flight_deadline_ms: number | null;
  trajectory_sink_enabled: boolean;
  // bigint comes back as string from pg by default
  trajectory_sink_max_bytes: string | number | null;
  trajectory_capture_nested_code_sessions: boolean;
}

const cache = new LruCache<string, TenantRuntimeConfig>({ max: 10_000, ttlMs: 60_000 });

const DEFAULTS: TenantRuntimeConfig = {
  maxDelegationDepth: null,
  maxDelegationFanout: null,
  defaultMaxConcurrentChildren: null,
  maxChildrenPerAgent: null,
  maxHitlBeforeInterrupt: null,
  reawaitInFlightDeadlineMs: null,
  trajectorySinkEnabled: true,
  trajectorySinkMaxBytes: null,
  trajectoryCaptureNestedCodeSessions: false,
};

function mapRowToConfig(row: TenantRuntimeConfigRow): TenantRuntimeConfig {
  return {
    maxDelegationDepth: row.max_delegation_depth,
    maxDelegationFanout: row.max_delegation_fanout,
    defaultMaxConcurrentChildren: row.default_max_concurrent_children,
    maxChildrenPerAgent: row.max_children_per_agent,
    maxHitlBeforeInterrupt: row.max_hitl_before_interrupt,
    reawaitInFlightDeadlineMs: row.reawait_in_flight_deadline_ms,
    trajectorySinkEnabled: row.trajectory_sink_enabled,
    trajectorySinkMaxBytes: row.trajectory_sink_max_bytes == null
      ? null
      : Number(row.trajectory_sink_max_bytes),
    trajectoryCaptureNestedCodeSessions: row.trajectory_capture_nested_code_sessions,
  };
}

export async function getTenantRuntimeConfig(tenantId: string): Promise<TenantRuntimeConfig> {
  const cached = cache.get(tenantId);
  if (cached) return cached;
  const pool = getPoolForService('default');
  const result = await pool.query<TenantRuntimeConfigRow>(
    'SELECT * FROM tenant_runtime_config WHERE tenant_id = $1',
    [tenantId],
  );
  const config = result.rows[0] ? mapRowToConfig(result.rows[0]) : DEFAULTS;
  cache.set(tenantId, config);
  return config;
}

export function invalidateTenantRuntimeConfig(tenantId: string): void {
  cache.delete(tenantId);
}
