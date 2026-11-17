/**
 * tools/migration/cutover-runner.ts
 *
 * Phase 1.5h: Orchestrates the BYOK_PROXY_SERVICE_ENABLED flag flip on
 * platform-backend from 'legacy' → 'new', with pre-flight checks and rollback.
 *
 * States: legacy → new
 *
 * Usage:
 *   npx tsx tools/migration/cutover-runner.ts             # dry-run (print plan)
 *   npx tsx tools/migration/cutover-runner.ts --execute   # flip to 'new'
 *   npx tsx tools/migration/cutover-runner.ts --rollback  # flip back to 'legacy'
 *
 * Required env vars:
 *   SOURCE_DB_URL     – PB DB connection (for credential count verification)
 *   TARGET_DB_URL     – byok DB connection (for credential count verification)
 *   BYOK_PROXY_URL    – byok Cloud Run service base URL (e.g. https://byok.example.run.app)
 *   GCP_PROJECT       – GCP project ID
 *
 * Optional env vars:
 *   GCP_REGION        – Cloud Run region (default: us-west1)
 *   PLATFORM_BACKEND_SERVICE – Cloud Run service name (default: platform-backend)
 *   COUNT_TOLERANCE   – Allowed ± fraction for credential count check (default: 0.10)
 */

import { Pool } from 'pg';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXECUTE = process.argv.includes('--execute');
const ROLLBACK = process.argv.includes('--rollback');

function assertEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

const COUNT_TOLERANCE = parseFloat(getEnvOrDefault('COUNT_TOLERANCE', '0.10'));
const REVISION_WAIT_MS = 30_000;

// ---------------------------------------------------------------------------
// Pre-flight: DB reachability
// ---------------------------------------------------------------------------

async function checkDbReachable(label: string, dbUrl: string): Promise<boolean> {
  const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5_000, max: 1 });
  try {
    await pool.query('SELECT 1');
    console.log(`  [OK] ${label} is reachable`);
    return true;
  } catch (err) {
    console.error(`  [FAIL] ${label} unreachable: ${(err as Error).message}`);
    return false;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: credential count parity
// ---------------------------------------------------------------------------

async function checkCredentialCountParity(
  sourceDbUrl: string,
  targetDbUrl: string,
): Promise<boolean> {
  const sourcePool = new Pool({ connectionString: sourceDbUrl, max: 1 });
  const targetPool = new Pool({ connectionString: targetDbUrl, max: 1 });

  try {
    const [srcResult, tgtResult] = await Promise.all([
      sourcePool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM claude_code_proxy_keys WHERE deleted_at IS NULL`,
      ),
      targetPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM byok_credentials`,
      ),
    ]);

    const srcCount = Number(srcResult.rows[0].count);
    const tgtCount = Number(tgtResult.rows[0].count);

    console.log(`  Source (claude_code_proxy_keys): ${srcCount} rows`);
    console.log(`  Target (byok_credentials):       ${tgtCount} rows`);

    if (srcCount === 0) {
      console.log(`  [OK] Source has 0 credentials — nothing to migrate.`);
      return true;
    }

    const deviation = Math.abs(srcCount - tgtCount) / srcCount;
    const tolerancePct = (COUNT_TOLERANCE * 100).toFixed(0);

    if (deviation <= COUNT_TOLERANCE) {
      console.log(
        `  [OK] Counts within ±${tolerancePct}% tolerance ` +
        `(deviation: ${(deviation * 100).toFixed(1)}%)`,
      );
      return true;
    } else {
      console.error(
        `  [FAIL] Count mismatch exceeds ±${tolerancePct}% tolerance ` +
        `(deviation: ${(deviation * 100).toFixed(1)}%). Run backfill first.`,
      );
      return false;
    }
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: byok service health
// ---------------------------------------------------------------------------

async function checkByokHealth(byokProxyUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const healthUrl = `${byokProxyUrl.replace(/\/$/, '')}/health`;
    const client = healthUrl.startsWith('https') ? https : http;

    const req = client.get(healthUrl, { timeout: 10_000 }, (res) => {
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
      if (ok) {
        console.log(`  [OK] byok /health returned HTTP ${res.statusCode}`);
      } else {
        console.error(`  [FAIL] byok /health returned HTTP ${res.statusCode}`);
      }
      resolve(ok);
    });

    req.on('error', (err) => {
      console.error(`  [FAIL] byok /health request failed: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error(`  [FAIL] byok /health request timed out`);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// gcloud helpers
// ---------------------------------------------------------------------------

function gcloudUpdateEnvVar(
  project: string,
  region: string,
  service: string,
  key: string,
  value: string,
): void {
  const cmd =
    `gcloud run services update ${service} ` +
    `--region=${region} ` +
    `--project=${project} ` +
    `--update-env-vars ${key}=${value}`;
  console.log(`  Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function gcloudTailLogs(project: string, region: string, service: string, lines: number): void {
  const cmd =
    `gcloud logging read ` +
    `"resource.type=cloud_run_revision AND resource.labels.service_name=${service}" ` +
    `--project=${project} ` +
    `--limit=${lines} ` +
    `--format="table(timestamp,textPayload)"`;
  console.log(`\n  Recent Cloud Run logs (last ${lines} entries):`);
  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 });
    console.log(output);
  } catch (err) {
    console.warn(`  Could not tail logs: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Pre-flight suite
// ---------------------------------------------------------------------------

interface PreflightResult {
  allPassed: boolean;
  checks: { name: string; passed: boolean }[];
}

async function runPreflightChecks(
  sourceDbUrl: string,
  targetDbUrl: string,
  byokProxyUrl: string,
): Promise<PreflightResult> {
  console.log('\n=== Pre-flight Checks ===\n');

  const checks: { name: string; passed: boolean }[] = [];

  console.log('1. Source DB reachability:');
  checks.push({ name: 'source-db', passed: await checkDbReachable('Source DB (PB)', sourceDbUrl) });

  console.log('\n2. Target DB reachability:');
  checks.push({ name: 'target-db', passed: await checkDbReachable('Target DB (byok)', targetDbUrl) });

  console.log('\n3. Credential count parity:');
  checks.push({ name: 'count-parity', passed: await checkCredentialCountParity(sourceDbUrl, targetDbUrl) });

  console.log('\n4. byok Cloud Run health:');
  checks.push({ name: 'byok-health', passed: await checkByokHealth(byokProxyUrl) });

  const allPassed = checks.every((c) => c.passed);
  console.log('\n--- Pre-flight result ---');
  for (const c of checks) {
    console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log(allPassed ? '\nAll checks passed.' : '\nOne or more checks FAILED.');

  return { allPassed, checks };
}

// ---------------------------------------------------------------------------
// Cutover
// ---------------------------------------------------------------------------

async function executeCutover(
  project: string,
  region: string,
  service: string,
): Promise<void> {
  console.log(`\n=== Executing Cutover ===`);
  console.log(`About to flip BYOK_PROXY_SERVICE_ENABLED to 'new' on ${service} (${project}/${region}).`);
  console.log('This will cause all new requests to use byok-proxy instead of the legacy PB handler.');
  console.log('Ctrl-C within 5 seconds to abort...\n');

  // Short pause for operator awareness (not a sleep loop — just one fixed pause).
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  gcloudUpdateEnvVar(project, region, service, 'BYOK_PROXY_SERVICE_ENABLED', 'new');

  console.log(`\nWaiting ${REVISION_WAIT_MS / 1000}s for new revision to become ready...`);
  await new Promise((resolve) => setTimeout(resolve, REVISION_WAIT_MS));

  gcloudTailLogs(project, region, service, 20);

  console.log('\nCutover complete. Monitor error rates and rollback if needed:');
  console.log(`  npx tsx tools/migration/cutover-runner.ts --rollback`);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

async function executeRollback(
  project: string,
  region: string,
  service: string,
): Promise<void> {
  console.log(`\n=== Executing Rollback ===`);
  console.log(`Flipping BYOK_PROXY_SERVICE_ENABLED back to 'legacy' on ${service}...`);

  gcloudUpdateEnvVar(project, region, service, 'BYOK_PROXY_SERVICE_ENABLED', 'legacy');

  console.log('\nRolled back to legacy mode.');
  console.log('byok-proxy is no longer in the request path. Verify platform-backend is healthy.');
}

// ---------------------------------------------------------------------------
// Dry-run summary
// ---------------------------------------------------------------------------

async function printDryRunSummary(
  project: string,
  region: string,
  service: string,
  sourceDbUrl: string,
  targetDbUrl: string,
  byokProxyUrl: string,
): Promise<void> {
  console.log('\n=== DRY-RUN SUMMARY (pass --execute to actually cut over) ===\n');
  console.log('This script will:');
  console.log(`  1. Run pre-flight checks against:`);
  console.log(`       Source DB : ${sourceDbUrl.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`       Target DB : ${targetDbUrl.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`       byok URL  : ${byokProxyUrl}`);
  console.log(`  2. If all checks pass, update Cloud Run service:`);
  console.log(`       Project : ${project}`);
  console.log(`       Region  : ${region}`);
  console.log(`       Service : ${service}`);
  console.log(`       Set     : BYOK_PROXY_SERVICE_ENABLED=new`);
  console.log(`  3. Wait 30s for the new revision to become ready.`);
  console.log(`  4. Tail last 20 Cloud Run log entries to check for errors.\n`);
  console.log('To rollback after cutover:');
  console.log('  npx tsx tools/migration/cutover-runner.ts --rollback\n');

  // Still run preflight in dry-run so the operator can see the current state.
  await runPreflightChecks(sourceDbUrl, targetDbUrl, byokProxyUrl);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== BYOK Cutover Runner ===');

  const sourceDbUrl = assertEnv('SOURCE_DB_URL');
  const targetDbUrl = assertEnv('TARGET_DB_URL');
  const byokProxyUrl = assertEnv('BYOK_PROXY_URL');
  const project = assertEnv('GCP_PROJECT');
  const region = getEnvOrDefault('GCP_REGION', 'us-west1');
  const service = getEnvOrDefault('PLATFORM_BACKEND_SERVICE', 'platform-backend');

  if (ROLLBACK) {
    await executeRollback(project, region, service);
    return;
  }

  if (EXECUTE) {
    const { allPassed } = await runPreflightChecks(sourceDbUrl, targetDbUrl, byokProxyUrl);
    if (!allPassed) {
      console.error('\nPre-flight checks failed. Aborting cutover. Fix the issues above and retry.');
      process.exit(1);
    }
    await executeCutover(project, region, service);
    return;
  }

  // Default: dry-run.
  await printDryRunSummary(project, region, service, sourceDbUrl, targetDbUrl, byokProxyUrl);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
