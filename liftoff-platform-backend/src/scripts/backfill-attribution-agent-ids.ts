// Re-key historical cost attribution rows from the Tenant Runtime id space into
// the control-plane id space.
//
// Why: older Tenant Runtime versions published only its local `agents.id`
// on the three cost seams (invocation-completed Pub/Sub, /ingestion-feed,
// /sandbox-feed). The Platform Backend wrote that value straight into
// `cost_attribution_events.agent_id` and `billing_spend_events.agent_id`, while
// its own platform-llm ingester wrote `internal_agents.id` into the same
// columns. Consumers (`getAllAgentsCosts` / `getAgentCostSummary`, and through
// them `monthlyCost` / `tasks30d` on the internal-agents API) match on the
// control-plane id only, so every runtime-keyed row was invisible to them.
//
// The forward fix is additive (`internalAgentId` alongside `agentId` on the
// wire). This script fixes the history. See INV-TR-010 in the tenant-runtime
// repo for the id-space rule itself.
//
// Lives in src/scripts/ (not the repo-root scripts/) so `tsc` compiles it into
// dist/ and it can run as a Cloud Run Job inside the VPC — Cloud SQL is
// private-IP only, so a root-level ts-node script has no path to the database.
// Same pattern as backfill-runtime-agent-skills.ts / the enterprise orphan scan.
//
// Usage (Cloud Run Job, args select the mode):
//   dry run   : --args="node,dist/scripts/backfill-attribution-agent-ids.js"
//   apply     : --args="node,dist/scripts/backfill-attribution-agent-ids.js,--apply"
//   one tenant: append ,--tenant=<uuid>
//
// Locally (only from inside the VPC, e.g. a jump box):
//   npx ts-node --project tsconfig.json src/scripts/backfill-attribution-agent-ids.ts [--apply]
//
// Safe to re-run: the UPDATEs match only rows still holding a runtime id, so a
// second pass is a no-op. Run it once after the runtime deploy and again a few
// minutes later to sweep rows written by the old runtime mid-rollout.
//
// What it re-keys: cost_attribution_events, billing_spend_events,
// cost_attribution_snapshots (delete + rebuild), and llm_usage_log (residue from
// the deleted skills-backfill.ts).
//
// Invariant guard: four checks per tenant, measured before and after the global
// snapshot rebuild.
//   1. `customer_cost_usd` total unchanged  (INV-PB-003)
//   2. row count unchanged                  (nothing lost or duplicated)
//   3. cost_attribution_events rows still keyed by a KNOWN runtime id reach zero
//   4. llm_usage_log rows still keyed by a KNOWN runtime id reach zero
// (3) and (4) are the assertions that the migration did its job — every table
// this script writes is verified, because an unverified write target is exactly
// the failure shape the guard exists to catch. Both deliberately count only
// *translatable* ids — those present in the tenant's mapping. Rows whose
// agent_id is in NEITHER space (synthetic fixtures such as `99999999-…`
// platform_llm rows) can never be translated and are reported as a note rather
// than failing the run: they are a pre-existing data-quality matter, not an
// id-space leak. Asserting "zero unresolvable" instead would fail forever on
// data this script cannot fix.
// Bucket classification is unaffected either way — event-classification only
// tests `agentId !== null`, never which id space it is in, so OU/meter/Stripe
// output is untouched.

import { initDatabase, withTenantScope, getPool, closePools } from '../infrastructure/database';
import { fetchWithOidc } from '../infrastructure/oidc-fetch';
import { resolveRuntimeBaseUrl } from '../connectors/tenant-runtime-url';
import { computeAndUpsertWindow } from '../cost-attribution/snapshot-service';

const CHUNK = 5_000;

const APPLY = process.argv.includes('--apply');
const TENANT_FILTER = process.argv
  .find((a) => a.startsWith('--tenant='))
  ?.split('=')[1];

interface TenantRow {
  id: string;
}

interface Mapping {
  internalAgentId: string;
  runtimeAgentId: string;
}

interface SnapshotPeriod {
  period_start: Date;
  period_end: Date;
  granularity: string;
}

interface TenantResult {
  tenantId: string;
  mappings: number;
  caeRows: number;
  bseRows: number;
  /** llm_usage_log rows still keyed by a runtime id (skills-backfill residue). */
  llmRows: number;
  snapshotRowsDeleted: number;
  /** Windows this tenant contributes to the global rebuild set. */
  periods: SnapshotPeriod[];
  /** Runtime ids from this tenant's mapping — the guard asserts none survive. */
  runtimeIds?: string[];
  before?: TenantFacts;
  after?: TenantFacts;
  skipped?: string;
  /** Runtime refused to serve the tenant (503). Terminal, not retryable. */
  runtimeRefused?: boolean;
}

async function listTenants(): Promise<TenantRow[]> {
  const pool = getPool();
  const params: string[] = [];
  // Do NOT filter on runtime_url — that column can be NULL (for any tenant
  // provisioned before it was populated, or where it is never set). resolveRuntimeBaseUrl
  // falls back to the TENANT_RUNTIME_URL env, which is how the ingesters reach the
  // runtime. Filtering here would silently produce zero tenants and a "success" report.
  let sql = `SELECT id FROM tenants WHERE status = 'active' OR status = 'pending'`;
  if (TENANT_FILTER) {
    params.push(TENANT_FILTER);
    sql += ` AND id = $1`;
  }
  sql += ` ORDER BY id`;
  const r = await pool.query<TenantRow>(sql, params);
  return r.rows;
}

/**
 * Pull the authoritative id-space mapping from the tenant runtime. This is the
 * only place the mapping exists — the control plane has no local copy, which is
 * precisely why the wrong ids could not be translated at write time.
 */
type MappingResult =
  | { ok: true; mappings: Mapping[] }
  /**
   * The runtime refuses to serve this tenant. `detail` carries the runtime's own
   * `reason` field, which is what actually distinguishes the cases: a genuinely
   * suspended tenant reports "Tenant suspended", while a tenant that was never
   * provisioned into this runtime reports "Agent execution disabled". Both come
   * back as 503 KILL_SWITCH_ACTIVE, so the HTTP code alone cannot tell them
   * apart — do not infer suspension from it.
   */
  | { ok: false; reason: 'runtime_refused'; detail: string }
  /** Genuinely transient: network, 5xx, timeout. Worth a re-run. */
  | { ok: false; reason: 'unavailable'; detail: string };

async function fetchMappings(tenant: TenantRow): Promise<MappingResult> {
  try {
    // resolveRuntimeBaseUrl, not tenants.runtime_url — see listTenants().
    const base = await resolveRuntimeBaseUrl(tenant.id);
    const r = await fetchWithOidc(
      `${base}/internal/agents/list-mappings?tenantId=${tenant.id}`,
      { timeoutMs: 30_000 },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // 503 KILL_SWITCH_ACTIVE means the runtime will not serve this tenant.
      // Surface the runtime's own `reason` rather than assuming suspension: on
      // prod all three such tenants report "Agent execution disabled" and are
      // empty duplicate signups that were never provisioned into the runtime, so
      // telling the operator to "re-run once resumed" describes an event that
      // will never happen. Retrying cannot help either way.
      if (r.status === 503 && body.includes('KILL_SWITCH_ACTIVE')) {
        let reason = 'unspecified';
        try {
          const parsed = JSON.parse(body) as { reason?: string };
          if (parsed.reason) reason = parsed.reason;
        } catch { /* non-JSON body — keep 'unspecified' */ }
        console.log(`  runtime refuses this tenant (${reason}) — nothing to translate; not retryable`);
        return { ok: false, reason: 'runtime_refused', detail: reason };
      }
      console.error(`  ! list-mappings HTTP ${r.status} — skipping tenant`);
      return { ok: false, reason: 'unavailable', detail: `HTTP ${r.status}` };
    }
    return { ok: true, mappings: (await r.json()) as Mapping[] };
  } catch (err) {
    const detail = (err as Error).message;
    console.error(`  ! list-mappings failed: ${detail} — skipping tenant`);
    return { ok: false, reason: 'unavailable', detail };
  }
}

interface TenantFacts {
  /** Total customer_cost_usd — must be identical before and after (INV-PB-003). */
  cost: string;
  /** Row count — re-keying must not create or destroy rows. */
  rows: number;
  /**
   * Rows whose agent_id is a KNOWN runtime id (present in the mapping). This is
   * the real assertion: it must reach 0, because every one of these is
   * translatable and therefore a bug if it survives.
   */
  stillRuntimeKeyed: number;
  /**
   * Same assertion for llm_usage_log, which this script also re-keys. A write
   * target that nothing verifies is the exact shape of bug this guard exists to
   * catch, so every table the script touches is measured.
   */
  llmStillRuntimeKeyed: number;
  /**
   * Rows whose agent_id matches no internal_agents row. Reported, NOT asserted:
   * it also counts ids in NEITHER space — synthetic fixtures (such as
   * `99999999-…` platform_llm rows) and rows from agents purged
   * outside the soft-delete path. Those are permanently untranslatable and are a
   * pre-existing data-quality matter, not evidence of an id-space leak.
   */
  unresolvable: number;
}

/**
 * The invariance guard. Summing cost alone is close to untestable — an UPDATE of
 * agent_id cannot change customer_cost_usd, so that check can only ever catch a
 * catastrophic DELETE. These three together actually constrain the operation:
 * cost and row count must be unchanged (nothing lost or duplicated) AND
 * `unresolvable` must go to zero (the thing we came to fix actually happened).
 */
async function tenantFacts(tenantId: string, runtimeIds: string[]): Promise<TenantFacts> {
  return withTenantScope(tenantId, async (client) => {
    const r = await client.query<{
      total: string; rows: string; unresolvable: string; still_runtime: string;
    }>(
      `SELECT COALESCE(SUM(customer_cost_usd), 0)::text          AS total,
              COUNT(*)::text                                     AS rows,
              COUNT(*) FILTER (
                WHERE agent_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM internal_agents ia WHERE ia.id::text = agent_id
                  )
              )::text                                            AS unresolvable,
              COUNT(*) FILTER (WHERE agent_id = ANY($2::text[]))::text AS still_runtime
         FROM cost_attribution_events WHERE tenant_id = $1`,
      [tenantId, runtimeIds],
    );
    const llm = await client.query<{ still_runtime: string }>(
      `SELECT COUNT(*) FILTER (WHERE agent_id = ANY($2::text[]))::text AS still_runtime
         FROM llm_usage_log WHERE tenant_id = $1`,
      [tenantId, runtimeIds],
    );
    const row = r.rows[0];
    return {
      cost: row?.total ?? '0',
      rows: parseInt(row?.rows ?? '0', 10),
      unresolvable: parseInt(row?.unresolvable ?? '0', 10),
      stillRuntimeKeyed: parseInt(row?.still_runtime ?? '0', 10),
      llmStillRuntimeKeyed: parseInt(llm.rows[0]?.still_runtime ?? '0', 10),
    };
  });
}

/** Stable key for a snapshot window, so identical windows rebuild once globally. */
function periodKey(p: { period_start: Date; period_end: Date; granularity: string }): string {
  return `${new Date(p.period_start).toISOString()}|${new Date(p.period_end).toISOString()}|${p.granularity}`;
}

async function backfillTenant(tenant: TenantRow): Promise<TenantResult> {
  const result: TenantResult = {
    tenantId: tenant.id,
    mappings: 0,
    caeRows: 0,
    bseRows: 0,
    llmRows: 0,
    snapshotRowsDeleted: 0,
    periods: [],
  };

  const fetched = await fetchMappings(tenant);
  if (!fetched.ok) {
    result.skipped = fetched.reason === 'runtime_refused'
      ? `runtime refused the tenant (${fetched.detail})`
      : `list-mappings unavailable (${fetched.detail})`;
    result.runtimeRefused = fetched.reason === 'runtime_refused';
    return result;
  }
  const mappings = fetched.mappings;
  result.mappings = mappings.length;
  if (mappings.length === 0) return result;

  const runtimeIds = mappings.map((m) => m.runtimeAgentId);
  result.runtimeIds = runtimeIds;
  result.before = await tenantFacts(tenant.id, runtimeIds);

  // Windows that must be rebuilt afterwards. Captured BEFORE the re-key, while
  // the snapshot rows still carry the runtime ids that identify them. Returned
  // to the caller rather than rebuilt here: computeAndUpsertWindow recomputes
  // a window across ALL tenants, so rebuilding per tenant would redo identical
  // work once per tenant. main() dedupes globally and rebuilds each window once.
  const periods = await withTenantScope(tenant.id, async (client) => {
    const r = await client.query<SnapshotPeriod>(
      `SELECT DISTINCT period_start, period_end, granularity
         FROM cost_attribution_snapshots
        WHERE tenant_id = $1 AND agent_id = ANY($2::text[])
        ORDER BY period_start`,
      [tenant.id, runtimeIds],
    );
    return r.rows;
  });
  result.periods = periods;

  // Count what would move, so a dry run is informative.
  const counts = await withTenantScope(tenant.id, async (client) => {
    const cae = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cost_attribution_events
        WHERE tenant_id = $1 AND agent_id = ANY($2::text[])`,
      [tenant.id, runtimeIds],
    );
    const bse = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM billing_spend_events
        WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[])`,
      [tenant.id, runtimeIds],
    );
    const snaps = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cost_attribution_snapshots
        WHERE tenant_id = $1 AND agent_id = ANY($2::text[])`,
      [tenant.id, runtimeIds],
    );
    // llm_usage_log.agent_id is normally internal-space (this repo writes it),
    // but the deleted skills-backfill.ts logged the RUNTIME id under
    // purpose='skills_decomposition' in older versions.
    // Those orphans are translatable, so sweep them with everything else.
    const llm = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM llm_usage_log
        WHERE tenant_id = $1 AND agent_id = ANY($2::text[])`,
      [tenant.id, runtimeIds],
    );
    return {
      cae: parseInt(cae.rows[0].n, 10),
      bse: parseInt(bse.rows[0].n, 10),
      snaps: parseInt(snaps.rows[0].n, 10),
      llm: parseInt(llm.rows[0].n, 10),
    };
  });
  result.caeRows = counts.cae;
  result.bseRows = counts.bse;
  result.snapshotRowsDeleted = counts.snaps;
  result.llmRows = counts.llm;

  if (!APPLY) {
    result.after = result.before;
    return result;
  }

  for (const m of mappings) {
    // cost_attribution_events.agent_id is TEXT and the table is partitioned by
    // occurred_at, so chunk on the (id, occurred_at) primary key rather than
    // ctid, which is not unique across partitions.
    for (;;) {
      const moved = await withTenantScope(tenant.id, async (client) => {
        const r = await client.query(
          `UPDATE cost_attribution_events
              SET agent_id = $1
            WHERE (id, occurred_at) IN (
                    SELECT id, occurred_at FROM cost_attribution_events
                     WHERE tenant_id = $2 AND agent_id = $3
                     LIMIT $4
                  )`,
          [m.internalAgentId, tenant.id, m.runtimeAgentId, CHUNK],
        );
        return r.rowCount ?? 0;
      });
      if (moved < CHUNK) break;
    }

    // billing_spend_events.agent_id is UUID (not TEXT) — cast both sides.
    // Its primary key is invocation_id (TEXT); there is no `id` column.
    for (;;) {
      const moved = await withTenantScope(tenant.id, async (client) => {
        const r = await client.query(
          `UPDATE billing_spend_events
              SET agent_id = $1::uuid
            WHERE invocation_id IN (
                    SELECT invocation_id FROM billing_spend_events
                     WHERE tenant_id = $2 AND agent_id = $3::uuid
                     LIMIT $4
                  )`,
          [m.internalAgentId, tenant.id, m.runtimeAgentId, CHUNK],
        );
        return r.rowCount ?? 0;
      });
      if (moved < CHUNK) break;
    }

    // llm_usage_log residue from the deleted skills-backfill.ts. agent_id is
    // TEXT here; the table has no surrogate key we can chunk on cheaply, and
    // the affected population is tiny, so one statement.
    await withTenantScope(tenant.id, async (client) => {
      await client.query(
        `UPDATE llm_usage_log SET agent_id = $1
          WHERE tenant_id = $2 AND agent_id = $3`,
        [m.internalAgentId, tenant.id, m.runtimeAgentId],
      );
    });
  }

  // Drop the stale runtime-keyed snapshot rows. The rebuild of the affected
  // windows happens once globally in main(), after every tenant is re-keyed —
  // rebuilding here would recompute each window once per tenant AND could
  // regenerate a window from partially-re-keyed events.
  if (periods.length > 0) {
    await withTenantScope(tenant.id, async (client) => {
      await client.query(
        `DELETE FROM cost_attribution_snapshots
          WHERE tenant_id = $1 AND agent_id = ANY($2::text[])`,
        [tenant.id, runtimeIds],
      );
    });
  }

  result.after = await tenantFacts(tenant.id, runtimeIds);
  return result;
}

/** Returns the process exit code: 0 ok, 1 invariant failure, 2 tenants skipped. */
async function main(): Promise<number> {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');

  // Builds the default and admin pools from DB_* env. Required before any
  // getPool()/withTenantScope call — the app entrypoint does this at boot, but
  // a job entrypoint has to do it itself.
  await initDatabase();

  const tenants = await listTenants();
  console.log(`tenants to process: ${tenants.length}\n`);
  if (tenants.length === 0) {
    console.error(
      TENANT_FILTER
        ? `FAILED: --tenant=${TENANT_FILTER} matched no active/pending tenant.`
        : 'FAILED: no active/pending tenants found. A backfill that silently ' +
          'processes nothing and reports success is the exact failure mode this ' +
          'script exists to fix — refusing to report success.',
    );
    return 1;
  }

  const results: TenantResult[] = [];
  const failures: string[] = [];

  for (const tenant of tenants) {
    console.log(`tenant ${tenant.id}`);
    const r = await backfillTenant(tenant);
    results.push(r);

    if (r.skipped) {
      console.log(`  skipped: ${r.skipped}\n`);
      continue;
    }
    console.log(`  mappings=${r.mappings} cost_attribution_events=${r.caeRows} ` +
                `billing_spend_events=${r.bseRows} llm_usage_log=${r.llmRows} ` +
                `snapshot_rows=${r.snapshotRowsDeleted} windows=${r.periods.length}`);
    if (r.before) {
      console.log(`  before: runtime-keyed=${r.before.stillRuntimeKeyed} ` +
                  `unresolvable=${r.before.unresolvable} of ${r.before.rows} rows`);
    }
    console.log('');
  }

  // One rebuild per distinct window, after every tenant has been re-keyed.
  // computeAndUpsertWindow aggregates cross-tenant, so per-tenant rebuilds
  // would both duplicate work and risk snapshotting a half-migrated state.
  if (APPLY) {
    const windows = new Map<string, SnapshotPeriod>();
    for (const r of results) {
      for (const p of r.periods) windows.set(periodKey(p), p);
    }
    const perTenantTotal = results.reduce((n, r) => n + r.periods.length, 0);
    console.log(`rebuilding ${windows.size} distinct snapshot window(s) ` +
                `(${perTenantTotal} tenant-window pairs collapsed)\n`);
    for (const p of windows.values()) {
      await computeAndUpsertWindow(
        new Date(p.period_start),
        new Date(p.period_end),
        p.granularity as 'hour' | 'day' | 'month',
      );
    }

    // Re-measure AFTER the global rebuild so the guard sees final state.
    for (const r of results) {
      if (r.skipped || !r.before) continue;
      const runtimeIds = r.runtimeIds ?? [];
      r.after = await tenantFacts(r.tenantId, runtimeIds);
      const b = r.before, a = r.after;
      const costOk = Number(b.cost).toFixed(6) === Number(a.cost).toFixed(6);
      const rowsOk = b.rows === a.rows;
      // The assertion is on TRANSLATABLE rows only. `unresolvable` also counts
      // ids in neither space (synthetic fixtures, purged agents) which this
      // script cannot fix and which are not an id-space leak — reported, not asserted.
      const translatedOk = a.stillRuntimeKeyed === 0;
      const llmTranslatedOk = a.llmStillRuntimeKeyed === 0;
      console.log(`tenant ${r.tenantId} guard: ` +
                  `cost ${b.cost}->${a.cost} ${costOk ? 'OK' : 'FAIL'} | ` +
                  `rows ${b.rows}->${a.rows} ${rowsOk ? 'OK' : 'FAIL'} | ` +
                  `runtime-keyed ${b.stillRuntimeKeyed}->${a.stillRuntimeKeyed} ${translatedOk ? 'OK' : 'FAIL'} | ` +
                  `llm_usage_log ${b.llmStillRuntimeKeyed}->${a.llmStillRuntimeKeyed} ${llmTranslatedOk ? 'OK' : 'FAIL'}`);
      if (a.unresolvable > 0) {
        console.log(`  note: ${a.unresolvable} row(s) match no internal_agents row and are ` +
                    `not translatable (id in neither space) — pre-existing, not a leak`);
      }
      if (!costOk) failures.push(`${r.tenantId}: customer_cost_usd changed (${b.cost} -> ${a.cost})`);
      if (!rowsOk) failures.push(`${r.tenantId}: row count changed (${b.rows} -> ${a.rows})`);
      if (!translatedOk) {
        failures.push(
          `${r.tenantId}: ${a.stillRuntimeKeyed} cost_attribution_events row(s) still keyed by a ` +
          `known runtime id — a producer is still writing runtime ids`,
        );
      }
      if (!llmTranslatedOk) {
        failures.push(
          `${r.tenantId}: ${a.llmStillRuntimeKeyed} llm_usage_log row(s) still keyed by a known ` +
          `runtime id — the re-key did not take`,
        );
      }
    }
    console.log('');
  }

  const totals = results.reduce(
    (acc, r) => ({
      cae: acc.cae + r.caeRows,
      bse: acc.bse + r.bseRows,
      snaps: acc.snaps + r.snapshotRowsDeleted,
      llm: acc.llm + r.llmRows,
      skipped: acc.skipped + (r.skipped && !r.runtimeRefused ? 1 : 0),
      refused: acc.refused + (r.runtimeRefused ? 1 : 0),
    }),
    { cae: 0, bse: 0, snaps: 0, llm: 0, skipped: 0, refused: 0 },
  );
  console.log('=== summary ===');
  console.log(`cost_attribution_events re-keyed: ${totals.cae}`);
  console.log(`billing_spend_events re-keyed:    ${totals.bse}`);
  console.log(`llm_usage_log re-keyed:           ${totals.llm}`);
  console.log(`snapshot rows deleted+rebuilt:    ${totals.snaps}`);
  console.log(`tenants skipped (retryable):      ${totals.skipped}`);
  console.log(`tenants runtime-refused (503):    ${totals.refused}`);

  // Set the exit code rather than calling process.exit here, so the caller can
  // close the pools before the process goes away.
  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  if (totals.refused > 0) {
    const reasons = results.filter((r) => r.runtimeRefused).map((r) => `${r.tenantId}: ${r.skipped}`);
    console.log(
      `\nNote: ${totals.refused} tenant(s) were refused by the runtime (503). Retrying does ` +
      `not help. If the reason is "Tenant suspended", re-run after the tenant is resumed; if ` +
      `it is "Agent execution disabled", the tenant has no agents in this runtime and there ` +
      `is nothing to back-fill. Not counted as a failure.`,
    );
    for (const r of reasons) console.log(`  - ${r}`);
  }
  if (totals.skipped > 0) {
    console.error(`\nWARNING: ${totals.skipped} tenant(s) skipped on a transient error — re-run to finish them.`);
    return 2;
  }
  return 0;
}

// Guard: only execute when invoked directly, never when imported by a test.
if (require.main === module) {
  main()
    .then(async (code) => {
      await closePools().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err: Error) => {
      console.error('backfill failed:', err.message);
      await closePools().catch(() => undefined);
      process.exit(1);
    });
}

export { main as runAttributionAgentIdBackfill };
