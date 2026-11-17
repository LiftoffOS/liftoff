// Internal-agent reconciler (plan §6). Catches drift between PB's
// internal_agents table and the runtime's mapping/instruction state across all
// active tenants. Republishes the appropriate event for missing-create,
// missing-instruction, stale-update, missed-delete. Orphans observed for >24h
// are auto-tombstoned via a synthetic delete event; first-seen orphans are
// log+metric only.
//
// Triggered every 5 min by Cloud Scheduler (see infrastructure terraform).
// Single-agent variant `reconcileOneAgentNow` is invoked by the runtime's
// chat-turn race fallback (plan §6.9).

import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { withAdminScope } from '../infrastructure/database';
import { fetchWithOidc } from '../infrastructure/oidc-fetch';
import { writeCustomMetric } from '../infrastructure/monitoring';
import { log } from '../infrastructure/logging';
import { enqueueInternalAgentOutbox, publishOutboxRowInline, type OutboxRowRef } from './outbox';
import { buildInternalAgentEventPayload } from './event-payload';
import { buildEffectiveInstructionsMd } from './effective-instructions-md';
import { mapInternalAgentRowWithDeletedAt, type InternalAgentRow } from './row-mapper';

// Per-runtime-URL semaphore — at most 5 concurrent calls into one tenant's
// runtime so one slow tenant can't fan out and DoS its agent-service.
// Plan §7.6.2.
const runtimeConcurrencyLimits = new Map<string, ReturnType<typeof pLimit>>();
function limitFor(runtimeUrl: string): ReturnType<typeof pLimit> {
  let limit = runtimeConcurrencyLimits.get(runtimeUrl);
  if (!limit) {
    limit = pLimit(5);
    runtimeConcurrencyLimits.set(runtimeUrl, limit);
  }
  return limit;
}

type DriftType =
  | 'missing_create'
  | 'missing_instruction'
  | 'stale_update'
  | 'stale_content'
  | 'missed_delete'
  | 'orphan_in_runtime';

interface RuntimeSyncState {
  hasMapping: boolean;
  runtimeAgentId?: string;
  lifecycle?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  hasActiveInstruction?: boolean;
  cachedEntityVersion?: number | null;
  cachedStatus?: 'active' | 'paused' | 'deleted' | null;
  // Field-level content hashes published by the TR sync-state route, computed
  // over the runtime's current state (agents.trigger_config,
  // compiled_instructions.{system_prompt,user_instructions,capability_tier},
  // agents.instructions_md). Absent when an older TR build hasn't yet
  // shipped the hashes — drift detection then skips stale_content and falls
  // back to version-only comparison, so we degrade safely.
  triggerConfigHash?: string;
  instructionsHash?: string;
  capabilityTier?: string | null;
  resultRulesHash?: string;
}

// Canonical key-sorted JSON serialization. MUST stay byte-identical to the
// TR runtime's canonicalize() in src/agent-lifecycle/sync-state-router.ts —
// any divergence would make every reconciler tick false-positive a
// stale_content drift and churn the outbox.
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}

function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Compute the PB-side content hashes for the three fields TR also hashes,
 * so classifyDrift can detect stale_content drift even when entity_version
 * is current. The shapes here MUST mirror the TR side exactly:
 *
 *   - triggerConfigHash: hash of agent.triggerConfig as JSON-readback object
 *   - instructionsHash: hash of { systemPrompt, userInstructions, instructionsMd }
 *     where instructionsMd is the *effective* value (buildEffectiveInstructionsMd)
 *     because that's what TR persists into agents.instructions_md after the
 *     event payload is applied.
 *
 * capabilityTier is compared as a raw string, no hash needed.
 *
 * resultRules gets its own hash rather than joining the instructionsHash
 * object. That object's canonical form is agreed with TR byte for byte, so
 * adding a key would change every agent's hash on both sides at once — and any
 * skew in deploy order between the two services would report the whole estate
 * as drifted and republish it.
 */
export async function computePbContentHashes(pbAgent: AgentRow): Promise<{
  triggerConfigHash: string;
  instructionsHash: string;
  capabilityTier: string | null;
  resultRulesHash: string;
}> {
  const effectiveInstructionsMd = await buildEffectiveInstructionsMd(pbAgent.tenantId, pbAgent);
  return {
    triggerConfigHash: sha256OfCanonical(pbAgent.triggerConfig ?? null),
    instructionsHash: sha256OfCanonical({
      systemPrompt: pbAgent.systemPrompt ?? null,
      userInstructions: pbAgent.userInstructions ?? null,
      instructionsMd: effectiveInstructionsMd ?? null,
    }),
    capabilityTier: pbAgent.capabilityTier ?? null,
    resultRulesHash: sha256OfCanonical(pbAgent.resultRules ?? []),
  };
}

// Re-exported for tests; internally we use this type for typed mutations.
type AgentRow = InternalAgentRow;

export interface ReconcileSummary {
  tenantsScanned: number;
  agentsScanned: number;
  drift: Record<DriftType, number>;
  republished: { created: number; updated: number; deleted: number };
  orphansInRuntime: Array<{ tenantId: string; runtimeAgentId: string }>;
  errors: number;
}

const ORPHAN_STABILIZATION_HOURS = 24;

export interface RunReconciliationOpts {
  dryRun: boolean;
  /** Optional: scope the pass to a single tenant. CI integration tests + ops use this. */
  tenantId?: string;
}

export async function runReconciliation(opts: RunReconciliationOpts): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    tenantsScanned: 0,
    agentsScanned: 0,
    drift: { missing_create: 0, missing_instruction: 0, stale_update: 0, stale_content: 0, missed_delete: 0, orphan_in_runtime: 0 },
    republished: { created: 0, updated: 0, deleted: 0 },
    orphansInRuntime: [],
    errors: 0,
  };

  // Per-tenant drift accumulator. Emitted as one time series per
  // (tenant_id, drift_type) so dashboards can group by either axis. Plan §6.2.
  const perTenantDrift = new Map<string, Record<DriftType, number>>();

  // Filter out kill-switched tenants — their runtimes correctly return 503
  // from the kill-switch middleware on every endpoint except /health and
  // /metrics, so calling /internal/agents/list-mappings and sync-state for
  // them is wasted work that produces only noise:
  //   - `agent_execution_allowed = false` agents can't run, so any "missed
  //     create / instruction drift / stale update" we'd detect can't be
  //     acted on until the entitlement flips back.
  //   - The cleanup pass at the bottom is already gated on
  //     `listMappingsSucceeded`, and that's permanently false for
  //     kill-switched runtimes — so we'd never delete anything anyway.
  // The JOIN is required (entitlements.tenant_id is FK to tenants.id) so
  // tenants without an entitlement row are excluded — those rows are
  // half-provisioned and not yet billable, and reconciling them would
  // also be premature.
  const tenants = await withAdminScope(
    { caller: 'reconciler.listTenants', reason: 'list reconcilable tenants (active + execution-allowed)' },
    (c) => opts.tenantId
      ? c.query<{ id: string; runtime_url: string }>(
          `SELECT t.id, t.runtime_url
             FROM tenants t
             JOIN entitlements e ON e.tenant_id = t.id
            WHERE t.id = $1
              AND t.status = 'active'
              AND t.runtime_url IS NOT NULL AND t.runtime_url <> ''
              AND e.tenant_operational_status = 'active'
              AND e.agent_execution_allowed = true`,
          [opts.tenantId],
        ).then((r) => r.rows)
      : c.query<{ id: string; runtime_url: string }>(
          `SELECT t.id, t.runtime_url
             FROM tenants t
             JOIN entitlements e ON e.tenant_id = t.id
            WHERE t.status = 'active'
              AND t.runtime_url IS NOT NULL AND t.runtime_url <> ''
              AND e.tenant_operational_status = 'active'
              AND e.agent_execution_allowed = true`,
        ).then((r) => r.rows),
  );

  for (const tenant of tenants) {
    summary.tenantsScanned++;
    const tenantDrift: Record<DriftType, number> = {
      missing_create: 0, missing_instruction: 0, stale_update: 0, stale_content: 0, missed_delete: 0, orphan_in_runtime: 0,
    };
    perTenantDrift.set(tenant.id, tenantDrift);
    try {
      await reconcileOneTenant(tenant, summary, tenantDrift, opts);
    } catch (err) {
      log.error({ tenantId: tenant.id, err: (err as Error).message }, 'reconciler: tenant pass failed');
      summary.errors++;
    }
  }

  // Emit metrics — one time series per (tenant_id, drift_type) so the
  // dashboard can group by either label and Alert 4a fires per-tenant rather
  // than only on the global aggregate. Plus a global aggregate for an
  // operator-facing "total drift" widget.
  //
  // IMPORTANT: every emission uses the SAME label set { drift_type, tenant_id,
  // scope }. Cloud Monitoring auto-creates the metric descriptor on first
  // emission and treats it as the canonical schema; subsequent emissions with
  // different label keys can be silently dropped or rejected. For the global
  // aggregate we set tenant_id="" so the schema stays stable regardless of
  // emission ordering across reconciler ticks (some passes have zero tenants;
  // first emission then would be global-only and would lock the schema without
  // tenant_id).
  const metricsProjectId = process.env.INTERNAL_AGENT_METRICS_PROJECT_ID;
  for (const [tenantId, drift] of perTenantDrift) {
    for (const [driftType, count] of Object.entries(drift)) {
      await writeCustomMetric({
        metricType: 'custom.googleapis.com/liftoff/internal_agents/drift_count',
        labels: { drift_type: driftType, tenant_id: tenantId, scope: 'per_tenant' },
        value: count,
        projectId: metricsProjectId,
      });
    }
  }
  for (const [driftType, count] of Object.entries(summary.drift)) {
    await writeCustomMetric({
      metricType: 'custom.googleapis.com/liftoff/internal_agents/drift_count',
      labels: { drift_type: driftType, tenant_id: '', scope: 'global' },
      value: count,
      projectId: metricsProjectId,
    });
  }

  // Emit reconciler_errors so alert I can fire when fetchSyncState repeatedly
  // fails for one or more tenants (e.g., wrong runtime_url, network blip).
  await writeCustomMetric({
    metricType: 'custom.googleapis.com/liftoff/internal_agents/reconciler_errors',
    labels: { scope: 'global' },
    value: summary.errors,
    projectId: metricsProjectId,
  });

  log.info({ ...summary } as Record<string, unknown>, 'reconciler: pass complete');
  return summary;
}

// Single-agent variant — called from POST /reconcile-now by the runtime's
// chat-turn race fallback. Synchronous, no metric emission, returns whether a
// repair was published.
export async function reconcileOneAgentNow(
  tenantId: string,
  internalAgentId: string,
): Promise<{ repaired: boolean; drift: DriftType | null }> {
  const tenantRow = await withAdminScope(
    { caller: 'reconciler.reconcileOneAgentNow.lookupTenant', actor: tenantId, reason: 'fetch runtime_url' },
    (c) => c.query<{ id: string; runtime_url: string }>(
      `SELECT id, runtime_url FROM tenants WHERE id = $1 AND runtime_url IS NOT NULL AND runtime_url <> ''`,
      [tenantId],
    ).then((r) => r.rows[0]),
  );
  if (!tenantRow) {
    return { repaired: false, drift: null };
  }

  const agent = await fetchAgentRow(tenantId, internalAgentId);
  if (!agent) {
    return { repaired: false, drift: null };
  }

  let state: RuntimeSyncState;
  try {
    state = await fetchSyncState(tenantRow.runtime_url, tenantId, internalAgentId);
  } catch (err) {
    log.warn({ tenantId, internalAgentId, err: (err as Error).message }, 'reconcile-now: sync-state fetch failed');
    return { repaired: false, drift: null };
  }

  // Compute PB-side hashes so classifyDrift can detect stale_content drift
  // (entity_version up to date but a behavior-affecting field on the runtime
  // side diverged from PB — happens when a past update event was applied by
  // a now-fixed buggy handler version, e.g. CSR's v22 pre-ec5fcc5 case).
  const pbHashes = await computePbContentHashes(agent);
  const drift = classifyDrift(agent, state, pbHashes);
  if (!drift || drift === 'orphan_in_runtime') {
    return { repaired: false, drift };
  }

  await republishForDrift(tenantId, agent, drift, { dryRun: false });
  return { repaired: true, drift };
}

/**
 * Force-republish a `tenant.internal_agent.updated` event for a single
 * agent regardless of detected drift state, with envelope entity_version=null
 * so the runtime's version gate is bypassed and the latest PB payload is
 * applied unconditionally. Operational lever — useful when:
 *
 *   - A historical event was applied by a buggy handler version that has
 *     since been fixed (canonical: CSR's v22 pre-ec5fcc5 trigger_config
 *     drop), and the current entity_version matches the runtime so neither
 *     the version-gated republish nor the stale_content hash compare will
 *     re-trigger naturally.
 *   - An ops operator wants to nudge a specific agent without waiting for
 *     the 5-min Cloud Scheduler reconciler tick.
 *
 * Returns the agent row's outbox details + whether the publish succeeded.
 */
export async function forceRepublishAgent(
  tenantId: string,
  internalAgentId: string,
): Promise<{ republished: boolean; reason: string }> {
  const agent = await fetchAgentRow(tenantId, internalAgentId);
  if (!agent) {
    return { republished: false, reason: 'agent_not_found' };
  }
  if (agent.deletedAt !== null) {
    return { republished: false, reason: 'agent_deleted' };
  }
  await republishForDrift(tenantId, agent, 'stale_content', { dryRun: false });
  return { republished: true, reason: 'forced_republish' };
}

async function reconcileOneTenant(
  tenant: { id: string; runtime_url: string },
  summary: ReconcileSummary,
  tenantDrift: Record<DriftType, number>,
  opts: { dryRun: boolean },
): Promise<void> {
  const agents: AgentRow[] = await withAdminScope(
    { caller: 'reconciler.scanTenant', actor: tenant.id, reason: 'list internal_agents (incl. soft-deleted)' },
    (c) => c.query<Record<string, unknown>>(
      `SELECT * FROM internal_agents WHERE tenant_id = $1`,
      [tenant.id],
    ).then((r) => r.rows.map(mapInternalAgentRowWithDeletedAt)),
  );

  // Fetch runtime mappings for orphan detection. Best-effort.
  //
  // `listMappingsSucceeded` gates the cleanup pass at the bottom of this
  // function. If the call fails (runtime briefly down, network blip, etc.),
  // an empty `runtimeMappings` is NOT proof that the tenant has no orphans —
  // it's proof that we don't know. The cleanup must NOT delete persisted
  // observation rows on a fetch failure or we'd wipe the stable-orphan
  // tracking for that tenant and reset the 24-hour stabilization clock.
  let runtimeMappings: Array<{ internalAgentId: string; runtimeAgentId: string }> = [];
  let listMappingsSucceeded = false;
  try {
    const r = await fetchWithOidc(`${tenant.runtime_url}/internal/agents/list-mappings?tenantId=${tenant.id}`);
    if (r.ok) {
      runtimeMappings = await r.json();
      listMappingsSucceeded = true;
    } else {
      log.error({ tenantId: tenant.id, status: r.status }, 'reconciler: list-mappings returned non-2xx');
      summary.errors++;
    }
  } catch (err) {
    log.error({ tenantId: tenant.id, err: (err as Error).message }, 'reconciler: list-mappings call failed');
    summary.errors++;
  }
  const pbAgentIds = new Set(agents.map((a) => a.id));

  const limit = limitFor(tenant.runtime_url);
  await Promise.all(agents.map((agent) => limit(async () => {
    summary.agentsScanned++;
    let state: RuntimeSyncState;
    try {
      state = await fetchSyncState(tenant.runtime_url, tenant.id, agent.id);
    } catch (err) {
      log.error(
        { tenantId: tenant.id, agentId: agent.id, err: (err as Error).message },
        'reconciler: sync-state fetch failed — skipping agent',
      );
      summary.errors++;
      return;
    }

    // PB-side content hashes: cheap (sha256 of canonicalize'd strings) and
    // tolerant of missing inputs, but require a DB read for
    // buildEffectiveInstructionsMd. Computed per-agent in parallel under the
    // same per-runtime-URL concurrency limit so we don't surge the PB pool.
    let pbHashes: Awaited<ReturnType<typeof computePbContentHashes>> | undefined;
    try {
      pbHashes = await computePbContentHashes(agent);
    } catch (err) {
      log.warn(
        { tenantId: tenant.id, agentId: agent.id, err: (err as Error).message },
        'reconciler: PB hash compute failed — falling back to version-only drift detection',
      );
    }

    const drift = classifyDrift(agent, state, pbHashes);
    if (drift) {
      summary.drift[drift]++;
      tenantDrift[drift]++;
      if (!opts.dryRun) {
        try {
          await republishForDrift(tenant.id, agent, drift, opts);
          if (drift === 'missing_create' || drift === 'missing_instruction') summary.republished.created++;
          else if (drift === 'stale_update' || drift === 'stale_content') summary.republished.updated++;
          else if (drift === 'missed_delete') summary.republished.deleted++;
        } catch (err) {
          log.error({ tenantId: tenant.id, agentId: agent.id, drift, err: (err as Error).message }, 'reconciler: republish failed');
          summary.errors++;
        }
      }
    }
  })));

  // Current-pass orphan set: (tenant_id, runtime_agent_id) pairs the runtime
  // still reports. Anything in orphan_observations for this tenant that is
  // NOT in this set has disappeared and must be deleted (plan §6.2). Without
  // this cleanup, a transient orphan leaves a stale row whose first_seen_at
  // remains in the past — if the same runtime_agent_id reappears later, the
  // reconciler treats it as immediately-stable and emits a false synthetic
  // delete.
  const currentOrphanRuntimeIds = new Set<string>();

  for (const m of runtimeMappings) {
    if (!pbAgentIds.has(m.internalAgentId)) {
      summary.drift.orphan_in_runtime++;
      tenantDrift.orphan_in_runtime++;
      summary.orphansInRuntime.push({ tenantId: tenant.id, runtimeAgentId: m.runtimeAgentId });
      currentOrphanRuntimeIds.add(m.runtimeAgentId);

      // observeOrphan mutates orphan_observations. In dryRun mode we must NOT
      // touch persistent state — the integration test runs dryRun=true on every
      // CI invocation and would otherwise pollute the table. Skip both the
      // observation INSERT/UPDATE and the synthetic-delete publish in dryRun.
      if (opts.dryRun) {
        log.info(
          { tenantId: tenant.id, runtimeAgentId: m.runtimeAgentId, internalAgentId: m.internalAgentId },
          'reconciler: dry-run — orphan observed but not recorded',
        );
        continue;
      }

      const observation = await observeOrphan(tenant.id, m.runtimeAgentId, m.internalAgentId, ORPHAN_STABILIZATION_HOURS);
      // Skip if we already published the synthetic delete on a prior pass — the
      // republished flag protects against re-emitting the same tombstone every
      // 5 min while we wait for the runtime to actually remove the mapping.
      if (observation.alreadyRepublished) {
        log.info(
          { tenantId: tenant.id, runtimeAgentId: m.runtimeAgentId, internalAgentId: m.internalAgentId },
          'reconciler: ORPHAN — synthetic delete already published on prior pass; awaiting runtime cleanup',
        );
        continue;
      }

      if (observation.stable) {
        log.warn(
          { tenantId: tenant.id, runtimeAgentId: m.runtimeAgentId, internalAgentId: m.internalAgentId, stabilizationHours: ORPHAN_STABILIZATION_HOURS },
          'reconciler: STABLE ORPHAN — auto-publishing synthetic deleted event',
        );
        const rowRef = await withAdminScope(
          { caller: 'reconciler.republish.stableOrphan', actor: tenant.id, reason: `orphan stable for >${ORPHAN_STABILIZATION_HOURS}h` },
          (c) => enqueueInternalAgentOutbox(c, {
            tenantId: tenant.id,
            internalAgentId: m.internalAgentId,
            eventType: 'tenant.internal_agent.deleted',
            entityVersion: null,
            payload: { id: m.internalAgentId, synthetic: true, reason: 'reconciler-stable-orphan' },
          }),
        );
        await publishOutboxRowInline(rowRef);
        await markOrphanRepublished(tenant.id, m.runtimeAgentId);
        summary.republished.deleted++;
      } else {
        log.error(
          { tenantId: tenant.id, runtimeAgentId: m.runtimeAgentId, internalAgentId: m.internalAgentId },
          'reconciler: ORPHAN (unstable) — observation recorded, will auto-publish after stabilization period',
        );
      }
    }
  }

  // Cleanup pass (plan §6.2): delete orphan_observations rows whose
  // (tenant_id, runtime_agent_id) is no longer in the current pass. Skip
  // when:
  //   - dryRun (don't mutate persistent state on CI invocations)
  //   - listMappingsSucceeded === false (we don't know what's current,
  //     so we cannot safely classify any row as "absent")
  if (!opts.dryRun && listMappingsSucceeded) {
    await cleanupAbsentOrphans(tenant.id, currentOrphanRuntimeIds);
  }
}

async function cleanupAbsentOrphans(tenantId: string, currentRuntimeIds: Set<string>): Promise<void> {
  await withAdminScope(
    { caller: 'reconciler.cleanupAbsentOrphans', actor: tenantId, reason: 'drop observations for orphans no longer present' },
    (c) => currentRuntimeIds.size === 0
      ? c.query(`DELETE FROM orphan_observations WHERE tenant_id = $1`, [tenantId])
      : c.query(
          `DELETE FROM orphan_observations
           WHERE tenant_id = $1 AND runtime_agent_id <> ALL($2::uuid[])`,
          [tenantId, [...currentRuntimeIds]],
        ),
  );
}

async function markOrphanRepublished(tenantId: string, runtimeAgentId: string): Promise<void> {
  await withAdminScope(
    { caller: 'reconciler.markOrphanRepublished', actor: tenantId, reason: 'flag stable orphan as tombstoned' },
    (c) => c.query(
      `UPDATE orphan_observations SET republished = TRUE
       WHERE tenant_id = $1 AND runtime_agent_id = $2`,
      [tenantId, runtimeAgentId],
    ),
  );
}

async function fetchSyncState(runtimeUrl: string, tenantId: string, internalAgentId: string): Promise<RuntimeSyncState> {
  const r = await fetchWithOidc(
    `${runtimeUrl}/internal/agents/sync-state?tenantId=${tenantId}&internalAgentId=${internalAgentId}`,
    { timeoutMs: 5000 },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json() as RuntimeSyncState;
}

async function fetchAgentRow(tenantId: string, internalAgentId: string): Promise<AgentRow | null> {
  const r = await withAdminScope(
    { caller: 'reconciler.fetchAgentRow', actor: tenantId, reason: 'single-agent lookup' },
    (c) => c.query<Record<string, unknown>>(
      `SELECT * FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
      [internalAgentId, tenantId],
    ).then((r) => (r.rows[0] ? mapInternalAgentRowWithDeletedAt(r.rows[0]) : null)),
  );
  return r;
}

interface OrphanObservation {
  stable: boolean;
  alreadyRepublished: boolean;
}

async function observeOrphan(
  tenantId: string,
  runtimeAgentId: string,
  internalAgentId: string,
  stableHours: number,
): Promise<OrphanObservation> {
  return withAdminScope(
    { caller: 'reconciler.observeOrphan', actor: tenantId, reason: 'track stable orphans' },
    async (c) => {
      const r = await c.query<{ first_seen_at: Date; republished: boolean }>(
        `INSERT INTO orphan_observations (tenant_id, runtime_agent_id, internal_agent_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (tenant_id, runtime_agent_id) DO UPDATE SET last_seen_at = NOW()
         RETURNING first_seen_at, republished`,
        [tenantId, runtimeAgentId, internalAgentId],
      );
      const firstSeen = r.rows[0].first_seen_at;
      const ageMs = Date.now() - firstSeen.getTime();
      return {
        stable: ageMs >= stableHours * 3600_000,
        alreadyRepublished: r.rows[0].republished === true,
      };
    },
  );
}

export function classifyDrift(
  pbAgent: AgentRow,
  runtime: RuntimeSyncState,
  pbHashes?: {
    triggerConfigHash: string;
    instructionsHash: string;
    capabilityTier: string | null;
    resultRulesHash: string;
  },
): DriftType | null {
  const pbDeleted = pbAgent.deletedAt !== null;
  if (!runtime.hasMapping) {
    return pbDeleted ? null : 'missing_create';
  }
  // Mapping exists.
  if (pbDeleted && runtime.cachedStatus !== 'deleted') {
    return 'missed_delete';
  }
  if (!pbDeleted) {
    // missing_instruction takes precedence over stale_update — re-publish
    // 'created' to trigger compile.
    if (runtime.hasActiveInstruction === false) {
      return 'missing_instruction';
    }
    const cached = runtime.cachedEntityVersion ?? -1;
    if (cached < pbAgent.currentVersion) {
      return 'stale_update';
    }
    // Version is current — but a past update event may have been processed
    // by a buggy handler version that silently dropped a payload field
    // (canonical case: CSR's v22 event hit subscriber.ts BEFORE commit
    // ec5fcc5 added trigger_config to handleInternalAgentUpdated). The
    // event_versions ledger marks the version as applied; classifyDrift
    // can't see the content drift via version comparison alone. We hash
    // the behavior-affecting fields on both sides and flag mismatches as
    // stale_content so republishForDrift can re-emit the latest payload
    // (with envelope entity_version=null to bypass the gate) and TR's
    // current handler writes the full state.
    //
    // Skipped when either side hasn't published hashes — the TR fields
    // are optional so we degrade safely against a not-yet-deployed
    // sync-state route (only version-based drift is detected then).
    if (pbHashes && runtime.triggerConfigHash && runtime.instructionsHash) {
      if (pbHashes.triggerConfigHash !== runtime.triggerConfigHash) return 'stale_content';
      if (pbHashes.instructionsHash !== runtime.instructionsHash) return 'stale_content';
      if (
        runtime.capabilityTier !== undefined &&
        runtime.capabilityTier !== null &&
        pbHashes.capabilityTier !== null &&
        pbHashes.capabilityTier !== runtime.capabilityTier
      ) {
        return 'stale_content';
      }
      // Guarded on presence for the same reason as the two hashes above: a TR
      // that has not shipped this field yet sends undefined, and treating that
      // as a mismatch would republish every agent in the estate during the gap
      // between the two deploys.
      if (
        runtime.resultRulesHash !== undefined &&
        pbHashes.resultRulesHash !== runtime.resultRulesHash
      ) {
        return 'stale_content';
      }
    }
  }
  return null;
}

async function republishForDrift(
  tenantId: string,
  pbAgent: AgentRow,
  drift: DriftType,
  _opts: { dryRun: boolean },
): Promise<void> {
  const eventType =
    drift === 'missing_create'      ? 'tenant.internal_agent.created' :
    drift === 'missing_instruction' ? 'tenant.internal_agent.created' :
    drift === 'stale_update'        ? 'tenant.internal_agent.updated' :
    drift === 'stale_content'       ? 'tenant.internal_agent.updated' :
    drift === 'missed_delete'       ? 'tenant.internal_agent.deleted' :
    null;
  if (!eventType) return;

  const payload = await buildInternalAgentEventPayload(pbAgent, eventType);

  // entity_version=null on the envelope (matches the migration 202 comment:
  // "nullable; backfill events publish with null to bypass runtime version
  // gate"). Reasoning:
  //
  //   - missed_delete: service.delete is a soft delete (`UPDATE deleted_at`)
  //     that does NOT bump current_version. event_versions on the runtime is
  //     at exactly current_version. Emitting 'deleted' at entity_version =
  //     current_version trips the strict-`>` gate and drops the event.
  //   - missing_instruction: the runtime processed the prior 'created' event
  //     to the point of updating event_versions but the compile step failed
  //     silently. Replay at the same version is gated.
  //   - missing_create / stale_update: harder to construct a gate-collision
  //     case in practice but the same risk exists.
  //
  // We carry pbAgent.currentVersion in the payload so handlers that update
  // their own caches (cached_internal_agents.entity_version,
  // agents.entity_version) can use the authoritative value. The envelope
  // entity_version omission only affects the runtime's pre-dispatch gate.
  const payloadWithVersion = { ...payload, entityVersion: pbAgent.currentVersion };

  const rowRef: OutboxRowRef = await withAdminScope(
    { caller: 'reconciler.republish', actor: tenantId, reason: `agent drift: ${drift}` },
    (c) => enqueueInternalAgentOutbox(c, {
      tenantId,
      internalAgentId: pbAgent.id,
      eventType,
      entityVersion: null,
      payload: payloadWithVersion,
    }),
  );
  await publishOutboxRowInline(rowRef);

  // Repair-rate counter for Alert 4b. CUMULATIVE because GCP rejects DELTA
  // for custom metrics — see infrastructure-gcp tenant-runtime-template.tf.
  await writeCustomMetric({
    metricType: 'custom.googleapis.com/liftoff/internal_agents/drift_repaired_total',
    labels: { drift_type: drift, tenant_id: tenantId },
    metricKind: 'CUMULATIVE',
    value: 1,
    projectId: process.env.INTERNAL_AGENT_METRICS_PROJECT_ID,
  });
}
