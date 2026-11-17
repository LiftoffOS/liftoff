#!/usr/bin/env node
// Prod dependency audit gate with a documented, time-boxed allowlist.
//
// Fails on any high/critical advisory in prod deps EXCEPT those explicitly
// allowlisted below. Each allowlist entry is a genuinely un-fixable-in-place
// advisory that requires a breaking major upgrade tracked as its own migration
// (so we don't mask NEW highs while that migration is scheduled).
//
// Review the allowlist by REVIEW_BY. Remove entries as the migration lands.
//
// Usage: node scripts/ci/audit-gate.mjs
import { execSync } from 'node:child_process';

const REVIEW_BY = '2026-10-01';

// GHSA -> reason. The fastify advisories are FIXED (billing is on fastify 5).
// The only remaining entry is the @opentelemetry advisory, which requires a
// PLATFORM-WIDE otel major: @liftoffos/telemetry declares otel as peer deps, so
// every service that consumes it must upgrade in lockstep. Tracked as a
// coordinated migration (telemetry-side upgrade is prepared; see
// harness/telemetry-otel-upgrade). Remove this entry once that lands.
const ALLOWLIST = {
  // otel advisory GHSA-q7rr-3cgh-j5r3 resolved by the @opentelemetry 2.x migration.
};

let report;
try {
  report = JSON.parse(execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch (e) {
  // npm audit exits non-zero when vulns exist; the JSON is still on stdout.
  report = JSON.parse(e.stdout || '{}');
}

const offenders = [];
for (const info of Object.values(report.vulnerabilities || {})) {
  if (info.severity !== 'high' && info.severity !== 'critical') continue;
  for (const via of info.via || []) {
    if (typeof via !== 'object' || !via.url) continue;
    const ghsa = via.url.split('/').pop();
    if (!ALLOWLIST[ghsa]) offenders.push(`${info.severity.toUpperCase()} ${ghsa} (${via.name}): ${via.title}`);
  }
}

const unique = [...new Set(offenders)];
if (unique.length) {
  console.error('Audit gate FAILED — high/critical advisories not on the allowlist:');
  unique.forEach((o) => console.error('  ' + o));
  console.error(`\nIf one is genuinely un-fixable-in-place, add it to ALLOWLIST in this file with a reason.`);
  process.exit(1);
}

const allowed = Object.keys(ALLOWLIST).length;
console.log(`Audit gate OK. ${allowed} advisory(ies) allowlisted (tracked migration; review by ${REVIEW_BY}).`);
