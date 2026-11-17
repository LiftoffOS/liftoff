// Re-book platform-funded Apify actor runs at the cost Apify actually charged.
//
// Why: until the executor started its runs by id, the cost of a run was read
// as "this actor's most recent run" right after the run finished. The platform
// Apify account is one account for every environment and every tenant, so a
// second run of the same actor starting seconds later (a test run of a newly
// adopted automation; another workspace asking at once) was routinely the one
// read, and a customer's run was booked at another run's price — or at $0,
// which books nothing. This script measures the gap per run and books the
// difference.
//
// Lives in src/scripts/ (not the repo-root scripts/) so `tsc` compiles it into
// dist/ and it can run as a Cloud Run Job inside the VPC — Cloud SQL is
// private-IP only. Same pattern as backfill-attribution-agent-ids.ts.
//
// Usage (Cloud Run Job; the job needs APIFY_PLATFORM_TOKEN mounted like the
// service has it):
//   report : --args="node,dist/scripts/apify-cost-trueup.js"
//   apply  : --args="node,dist/scripts/apify-cost-trueup.js,--apply"
//   window : append ,--since=2026-09-10   (default: the last 48 hours, the scheduled mode)
//
// How a run is attributed to THIS environment and tenant: every executor call
// wrote a capability_usage_evidence row with the tenant and the moment the run
// finished, in the environment that ran it. The row is keyed one of two ways:
// runs before the evidence-identity fix wrote (source 'connector_registry',
// source_ref 'apify:run_actor'); runs since write (source 'apify_store',
// source_ref '<username>/<actor>'), the key the store search ranks the actor
// under. BOTH are read here — a reader of the old key alone would hide every
// new actor run from reconciliation. A run with no evidence row here belongs
// to another environment, or was a platform test run (those never wrote
// evidence), and is reported, never booked. A run whose evidence is ambiguous
// (two candidates) is reported too.
//
// How the delta is booked: through ingestEventWithBuckets, the one consumption
// boundary, under source_id `apify:run:<id>:trueup` (no slash: `<key>/<suffix>`
// is how the ledger names one booking's bucket rows) at the run's start time.
// A positive delta drains buckets like any charge, a negative one refunds
// through applyOuRefund, and a run that booked nothing is booked in full under
// `apify:run:<id>`, the key the fixed executor uses. usage_quantity stays at
// the ORIGINAL row's 1 call: a true-up adds money, not a second call.
//
// Safe to re-run: the booked figure is re-read from the ledger each time, so a
// second pass finds every delta at zero and writes nothing.

import { initDatabase, withAdminScope, closePools } from '../infrastructure/database';
import { ingestEventWithBuckets, resolveAccountIdForTenant } from '../cost-attribution/repository';
import { listApifyPrepaidTokensForReads } from '../billing/apify-prepaid-token-service';
import { apifyRunRef } from '../capability-discovery/vendor-execution';

const APPLY = process.argv.includes('--apply');
/** The window: `--since=YYYY-MM-DD` for a one-off pass over history, else the
 *  last RECONCILE_HOURS, which is how the scheduled run is invoked. */
const SINCE_ARG = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
const RECONCILE_HOURS = 48;

const APIFY_BASE = 'https://api.apify.com/v2';
/** How far an evidence row's created_at may sit from the run's finishedAt,
 *  for runs booked before the executor keyed everything by run id. The
 *  evidence was written after the old cost read (one extra request). Runs
 *  booked since carry the run id in the evidence row's output_note and in the
 *  ledger's source_id, and are matched on that, exactly. */
const EVIDENCE_TOLERANCE_MS = 8_000;
/** How far the ledger's occurred_at (the executor's own clock at start) may
 *  sit from Apify's startedAt, for the same pre-run-id rows. A settlement
 *  read now waits up to 15 s before booking, so the window is wider than the
 *  wait. */
const LEDGER_TOLERANCE_MS = 25_000;
/** Below this the figures agree; NUMERIC rounding, not money. */
const NEGLIGIBLE_USD = 0.000001;

interface ApifyRunSummary {
  id: string;
  actId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  usageTotalUsd: number;
}

/** Which bearer a run was listed under. A run on a prepaid token was paid by
 *  the x402 wallet and its correction must land in that bucket too, beside
 *  the row the executor booked. */
type RunFunding = 'platform_key' | 'x402_wallet';

export interface EvidenceRow {
  source: string;
  source_ref: string;
  tenant_id: string;
  created_at: Date;
  latency_ms: number | null;
  cost_usd: string | null;
  output_note: string | null;
}

/** The two keys an executor call's evidence row can carry. The legacy pair is
 *  exact; the new key is any row under the store source, because its
 *  source_ref is the actor id and there is one per actor. */
export const LEGACY_EVIDENCE_KEY = { source: 'connector_registry', sourceRef: 'apify:run_actor' } as const;
export const STORE_EVIDENCE_SOURCE = 'apify_store';

/** The evidence rows an executor wrote since `since`, under EITHER key. */
export async function loadExecutorEvidence(since: Date): Promise<EvidenceRow[]> {
  return withAdminScope<EvidenceRow[]>(
    { caller: 'scripts.apify-cost-trueup', reason: 'cross-tenant read of usage evidence for reconciliation' },
    async (client) => (await client.query<EvidenceRow>(
      `SELECT source, source_ref, tenant_id, created_at, latency_ms, cost_usd, output_note
         FROM capability_usage_evidence
        WHERE ((source = $2 AND source_ref = $3) OR source = $4)
          AND created_at >= $1
        ORDER BY created_at`,
      [since, LEGACY_EVIDENCE_KEY.source, LEGACY_EVIDENCE_KEY.sourceRef, STORE_EVIDENCE_SOURCE],
    )).rows,
  );
}

/** The evidence rows that could be THIS run's, whichever key they carry.
 *
 *  Exact first: a row whose output_note names the run id is the executor's
 *  own record of it, and one run has exactly one such row. The time window is
 *  for rows written before the executor keyed its bookings by run id — those
 *  carry no run id at all, so a row that names ANY run is never a window
 *  candidate for a different one. Two runs of two actors, or for two
 *  tenants, that finished seconds apart therefore never take each other's
 *  row once both are keyed; only two pre-run-id rows in one window are
 *  ambiguous, and those are reported rather than guessed. */
export function evidenceForRun(
  run: Pick<ApifyRunSummary, 'id' | 'finishedAt'>,
  evidence: EvidenceRow[],
  toleranceMs: number = EVIDENCE_TOLERANCE_MS,
): { kind: 'exact' | 'window'; rows: EvidenceRow[] } {
  const ref = apifyRunRef(run.id);
  const keyed = evidence.filter((e) => (e.output_note ?? '').includes(ref));
  if (keyed.length > 0) return { kind: 'exact', rows: keyed };
  const finishedAt = new Date(run.finishedAt as string).getTime();
  return {
    kind: 'window',
    rows: evidence.filter(
      (e) => !(e.output_note ?? '').includes('apify:run:')
        && Math.abs(e.created_at.getTime() - finishedAt) <= toleranceMs,
    ),
  };
}

/** Everything the ledger holds for one run, whichever way it was keyed: the
 *  run-id key and its bucket rows (`apify:run:<id>`, `apify:run:<id>/<bucket>`)
 *  and true-ups (`apify:run:<id>:trueup`), plus — for runs booked before the
 *  key existed — rows in the tenant's window around the run's start. */
async function bookedForRun(tenantId: string, runId: string, startedAt: Date, caller: string): Promise<number> {
  const key = apifyRunRef(runId);
  return withAdminScope<number>(
    { caller: 'scripts.apify-cost-trueup', reason: caller },
    async (client) => {
      const r = await client.query<{ booked: string | null }>(
        `SELECT SUM(cost_usd)::text AS booked
           FROM cost_attribution_events
          WHERE tenant_id = $1
            AND connector = 'apify' AND action_type = 'run_actor'
            AND (
              source_id = $2 OR source_id LIKE $2 || '/%' OR source_id LIKE $2 || ':%'
              OR (source_id NOT LIKE 'apify:run:%'
                  AND occurred_at BETWEEN $3::timestamptz - make_interval(secs => $4)
                                      AND $3::timestamptz + make_interval(secs => $4))
            )`,
        [tenantId, key, startedAt.toISOString(), LEDGER_TOLERANCE_MS / 1000],
      );
      return round6(Number(r.rows[0]?.booked ?? 0));
    },
  );
}

interface RunReport {
  runId: string;
  actId: string;
  startedAt: string;
  tenantId: string | null;
  apifyUsd: number;
  bookedUsd: number;
  deltaUsd: number;
  note: string;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function listRuns(token: string, since: Date): Promise<ApifyRunSummary[]> {
  const resp = await fetch(`${APIFY_BASE}/actor-runs?desc=1&limit=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Apify run list failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { data?: { items?: ApifyRunSummary[] } };
  return (body.data?.items ?? []).filter((r) => new Date(r.startedAt) >= since && r.finishedAt);
}

async function main(): Promise<number> {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== REPORT (pass --apply to write) ===');
  const token = process.env.APIFY_PLATFORM_TOKEN;
  if (!token || !token.trim()) {
    console.error('FAILED: APIFY_PLATFORM_TOKEN is not set; nothing can be compared.');
    return 1;
  }
  await initDatabase();

  const since = SINCE_ARG
    ? new Date(`${SINCE_ARG}T00:00:00Z`)
    : new Date(Date.now() - RECONCILE_HOURS * 3_600_000);
  // The account's runs, then the runs on every prepaid token still held:
  // a run started on a token is invisible to the account key, and a
  // reconciler that read the account alone would never see a prepaid run's
  // late charge. A run cannot be listed under both, but the union is keyed
  // by run id anyway.
  const funding = new Map<string, RunFunding>();
  const runs: ApifyRunSummary[] = [];
  for (const run of await listRuns(token, since)) {
    if (!funding.has(run.id)) { funding.set(run.id, 'platform_key'); runs.push(run); }
  }
  const prepaid = await listApifyPrepaidTokensForReads();
  for (const t of prepaid) {
    let onToken: ApifyRunSummary[] = [];
    try {
      onToken = await listRuns(t.token, since);
    } catch (err) {
      console.error(`  prepaid token ${t.id}: run list failed (${(err as Error).message}); its runs are not reconciled this pass`);
      continue;
    }
    for (const run of onToken) {
      if (!funding.has(run.id)) { funding.set(run.id, t.fundedBy === 'locus' ? 'platform_key' : 'x402_wallet'); runs.push(run); }
    }
  }
  console.log(`apify runs since ${since.toISOString()}: ${runs.length} (${[...funding.values()].filter((f) => f === 'x402_wallet').length} on ${prepaid.length} prepaid token(s))`);

  const evidence = await loadExecutorEvidence(since);
  const storeKeyed = evidence.filter((e) => e.source === STORE_EVIDENCE_SOURCE).length;
  console.log(
    `executor calls recorded here since ${since.toISOString()}: ${evidence.length} `
    + `(${storeKeyed} under the actor key, ${evidence.length - storeKeyed} under the legacy key)\n`,
  );

  const reports: RunReport[] = [];
  for (const run of runs) {
    const startedAt = new Date(run.startedAt);
    const apifyUsd = round6(run.usageTotalUsd ?? 0);
    const { rows: candidates } = evidenceForRun(run, evidence);
    const base = { runId: run.id, actId: run.actId, startedAt: run.startedAt, apifyUsd };
    if (candidates.length === 0) {
      reports.push({ ...base, tenantId: null, bookedUsd: 0, deltaUsd: 0, note: 'not run from this environment (or a platform test run); skipped' });
      continue;
    }
    if (candidates.length > 1) {
      reports.push({ ...base, tenantId: null, bookedUsd: 0, deltaUsd: 0, note: `ambiguous: ${candidates.length} executor calls finished within ${EVIDENCE_TOLERANCE_MS / 1000}s; skipped` });
      continue;
    }
    const tenantId = candidates[0].tenant_id;
    const bookedUsd = await bookedForRun(tenantId, run.id, startedAt, 'cross-tenant read of the ledger for reconciliation');
    const deltaUsd = round6(apifyUsd - bookedUsd);
    const note = Math.abs(deltaUsd) < NEGLIGIBLE_USD
      ? 'agrees'
      : bookedUsd === 0
        ? 'nothing booked: book in full'
        : deltaUsd > 0 ? 'under-booked: charge the difference' : 'over-booked: refund the difference';
    reports.push({ ...base, tenantId, bookedUsd, deltaUsd, note });
  }

  console.log('run id             | started (UTC)        | tenant                               | apify $   | booked $  | delta $   | note');
  for (const r of reports) {
    console.log(
      `${r.runId.padEnd(18)} | ${r.startedAt.slice(0, 19).replace('T', ' ')} | ${(r.tenantId ?? '-').padEnd(36)} | ` +
      `${r.apifyUsd.toFixed(6)} | ${r.bookedUsd.toFixed(6)} | ${r.deltaUsd >= 0 ? '+' : ''}${r.deltaUsd.toFixed(6)} | ${r.note}`,
    );
  }
  const actionable = reports.filter((r) => r.tenantId && Math.abs(r.deltaUsd) >= NEGLIGIBLE_USD);
  const totalDelta = round6(actionable.reduce((s, r) => s + r.deltaUsd, 0));
  console.log(`\nruns needing a correction: ${actionable.length}; net delta ${totalDelta >= 0 ? '+' : ''}$${totalDelta.toFixed(6)}`);

  if (!APPLY) return 0;
  if (actionable.length === 0) {
    console.log('nothing to write.');
    return 0;
  }

  let written = 0;
  for (const r of actionable) {
    const accountId = await resolveAccountIdForTenant(r.tenantId as string);
    if (!accountId) {
      console.error(`  ${r.runId}: tenant ${r.tenantId} has no account; not booked`);
      continue;
    }
    const fullBooking = r.bookedUsd === 0;
    const sourceId = fullBooking ? apifyRunRef(r.runId) : `${apifyRunRef(r.runId)}:trueup`;
    const inserted = await ingestEventWithBuckets(accountId, sourceId, r.deltaUsd, {
      tenantId: r.tenantId as string,
      eventType: 'connector_call',
      source: 'tenant_runtime',
      connector: 'apify',
      actionType: 'run_actor',
      occurredAt: new Date(r.startedAt),
      usageQuantity: fullBooking ? 1 : 0,
      usageUnit: 'call',
      ...(funding.get(r.runId) === 'x402_wallet' ? { x402Funded: true } : {}),
    });
    written += inserted;
    console.log(`  ${r.runId}: booked ${r.deltaUsd >= 0 ? '+' : ''}$${r.deltaUsd.toFixed(6)} as ${sourceId} (${inserted} ledger row(s))`);
  }
  console.log(`\nledger rows written: ${written}`);

  // The after-state, re-read from the ledger rather than tallied from the
  // writes above: what the run is booked at now.
  console.log('\nafter-state:');
  for (const r of actionable) {
    const booked = await bookedForRun(
      r.tenantId as string, r.runId, new Date(r.startedAt), 'cross-tenant re-read of the ledger after the true-up',
    );
    const ok = Math.abs(booked - r.apifyUsd) < NEGLIGIBLE_USD;
    console.log(`  ${r.runId}: apify $${r.apifyUsd.toFixed(6)} ledger $${booked.toFixed(6)} ${ok ? 'OK' : 'MISMATCH'}`);
    if (!ok) return 1;
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
      console.error('apify cost true-up failed:', err.message);
      await closePools().catch(() => undefined);
      process.exit(1);
    });
}
