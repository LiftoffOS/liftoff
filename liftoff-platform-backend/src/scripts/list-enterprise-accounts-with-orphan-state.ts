// PR 6 — Post-deploy scan: list enterprise accounts whose current state has
// curated inconsistencies (per `inferHealthIssues`). Output drives the manual
// "retroactive cleanup" procedure in
// docs/runbooks/ENTERPRISE_PROVISIONING.md.
//
// Read-only: no destructive side effects. Lists enterprise accounts from
// billing_controls, calls readAccountState for each (same code path as
// GET /api/admin/accounts/:accountId/state), filters to accounts where
// inferHealthIssues returns a non-empty list, prints a JSON report to stdout.
//
// Designed to run as the Cloud Run job `platform-backend-enterprise-orphan-scan`:
//   gcloud run jobs execute platform-backend-enterprise-orphan-scan \
//     --project=YOUR_GCP_PROJECT<env> --wait
//
// Also runnable directly during development:
//   DATABASE_URL=<prod-control-plane-pg-url> STRIPE_SECRET_KEY_NAME=<secret> \
//     npx ts-node src/scripts/list-enterprise-accounts-with-orphan-state.ts
//
// The script is deliberately a SCAN, not a fix. Per Q12 / PR 6's no-automated-
// bulk-cleanup rule, the actual cleanup runs through PR 5's enterprise-setup
// endpoint, one tenant at a time, with operator judgment per call.

import { initDatabase, closePools, getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  readAccountState,
  inferHealthIssues,
  type AccountStateSnapshot,
} from '../admin/account-state-service';

export interface ScannedAccount {
  accountId: string;
  email: string;
  snapshot: AccountStateSnapshot;
  issues: string[];
}

export interface OrphanScanReport {
  scannedAt: string;
  totalEnterpriseAccounts: number;
  flaggedAccounts: number;
  flagged: Array<{
    accountId: string;
    email: string;
    issues: string[];
  }>;
}

// Pure builder — extracted so the test can exercise the filtering without
// real DB / Stripe calls.
export function buildReport(scanned: ScannedAccount[]): OrphanScanReport {
  const flagged = scanned.filter((a) => a.issues.length > 0);
  return {
    scannedAt: new Date().toISOString(),
    totalEnterpriseAccounts: scanned.length,
    flaggedAccounts: flagged.length,
    flagged: flagged.map((a) => ({
      accountId: a.accountId,
      email: a.email,
      issues: a.issues,
    })),
  };
}

async function main(): Promise<number> {
  await initDatabase();

  const pool = getPool();
  const { rows } = await pool.query<{ account_id: string }>(
    `SELECT account_id
       FROM billing_controls
      WHERE billing_tier = 'enterprise'
      ORDER BY account_id`,
  );

  log.info(
    { totalEnterpriseAccounts: rows.length },
    'enterprise-orphan-scan.starting',
  );

  const scanned: ScannedAccount[] = [];
  for (const row of rows) {
    try {
      const snapshot = await readAccountState(row.account_id);
      const issues = inferHealthIssues(snapshot);
      scanned.push({
        accountId: row.account_id,
        email: snapshot.account.email,
        snapshot,
        issues,
      });
    } catch (err) {
      // Scan failures on individual accounts must not abort the whole run.
      // The operator can re-scan the failed account manually via the state
      // endpoint after fixing the underlying error.
      log.error(
        { err, accountId: row.account_id },
        'enterprise-orphan-scan.account_failed',
      );
    }
  }

  const report = buildReport(scanned);
  // Print JSON to stdout — Cloud Run job output ends up in Cloud Logging
  // structured-payload form via the runtime collector.
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  log.info(
    {
      totalEnterpriseAccounts: report.totalEnterpriseAccounts,
      flaggedAccounts: report.flaggedAccounts,
    },
    'enterprise-orphan-scan.complete',
  );

  return 0;
}

async function run(): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await main();
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      'enterprise-orphan-scan: unexpected error',
    );
    exitCode = 1;
  } finally {
    try {
      await closePools();
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        'enterprise-orphan-scan: closePools failed during shutdown',
      );
    }
  }
  process.exitCode = exitCode;
}

// Guard: only execute when invoked directly (not when imported by tests).
if (require.main === module) {
  void run();
}
