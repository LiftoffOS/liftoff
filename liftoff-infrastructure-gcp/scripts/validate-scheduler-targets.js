#!/usr/bin/env node
// WS-9.6 — CI scheduler-target validator (plain Node, no build step).
//
// Reads a `terraform show -json` output (or a stored tfplan.json), enumerates
// every google_cloud_scheduler_job whose http_target.uri points at a Cloud
// Run service URL, then for each unique service URL fetches the
// /__routes introspection endpoint (added in WS-9.6 tenant-runtime/index.ts
// + platform-backend/index.ts) and asserts that every job's path component
// exists in the route set. Exits non-zero on any mismatch.
//
// Usage:
//   node validate-scheduler-targets.js \
//     --plan tfplan.json \
//     --introspect-token "$INTROSPECT_TOKEN" \
//     [--allow-missing-introspect]

'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const out = { plan: '', introspectToken: '', allowMissingIntrospect: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = argv[++i] || '';
    else if (a === '--introspect-token') out.introspectToken = argv[++i] || '';
    else if (a === '--allow-missing-introspect') out.allowMissingIntrospect = true;
  }
  if (!out.plan) {
    console.error(
      'Usage: validate-scheduler-targets --plan <tfplan.json> ' +
        '[--introspect-token <token>] [--allow-missing-introspect]',
    );
    process.exit(2);
  }
  return out;
}

function collectSchedulerJobs(plan) {
  const out = [];
  function walk(resources) {
    for (const r of resources || []) {
      if (r.type === 'google_cloud_scheduler_job') {
        const uri = r.values && r.values.http_target && r.values.http_target[0] && r.values.http_target[0].uri;
        const name = r.values && r.values.name;
        if (uri && name) out.push({ name, uri });
      }
    }
  }
  const planned = plan.planned_values || {};
  const rm = planned.root_module || {};
  walk(rm.resources);
  for (const m of rm.child_modules || []) walk(m.resources);
  return out;
}

async function fetchRoutes(serviceUrl, token) {
  try {
    const resp = await fetch(`${serviceUrl}/__routes`, {
      headers: { 'x-service-auth': token },
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return new Set((body.routes || []).map((r) => r.path || '').filter(Boolean));
  } catch {
    return null;
  }
}

function extractServiceBaseAndPath(uri) {
  try {
    const u = new URL(uri);
    return { base: `${u.protocol}//${u.host}`, path: u.pathname };
  } catch {
    return null;
  }
}

function matchExpressTemplate(template, actual) {
  const tParts = template.split('/');
  const aParts = actual.split('/');
  if (tParts.length !== aParts.length) return false;
  for (let i = 0; i < tParts.length; i++) {
    if (tParts[i].startsWith(':')) continue;
    if (tParts[i] !== aParts[i]) return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const planJson = JSON.parse(fs.readFileSync(args.plan, 'utf-8'));
  const jobs = collectSchedulerJobs(planJson);
  console.log(`Inspecting ${jobs.length} Cloud Scheduler job(s)...`);

  const routesByService = new Map();
  const failures = [];

  for (const job of jobs) {
    const sp = extractServiceBaseAndPath(job.uri);
    if (!sp) {
      failures.push({ job: job.name, uri: job.uri, reason: 'invalid URI' });
      continue;
    }
    if (!sp.base.includes('.run.app') && !sp.base.includes('run.googleusercontent')) {
      // Not a Cloud Run service — out of scope.
      continue;
    }
    let routes = routesByService.get(sp.base);
    if (routes === undefined) {
      routes = await fetchRoutes(sp.base, args.introspectToken);
      routesByService.set(sp.base, routes);
    }
    if (!routes) {
      if (args.allowMissingIntrospect) continue;
      failures.push({
        job: job.name,
        uri: job.uri,
        reason: `/__routes introspection failed at ${sp.base} (rerun with --allow-missing-introspect to skip when service isn't deployed yet)`,
      });
      continue;
    }
    const found = [...routes].some((r) => r === sp.path || matchExpressTemplate(r, sp.path));
    if (!found) {
      failures.push({
        job: job.name,
        uri: job.uri,
        reason: `path ${sp.path} not registered on ${sp.base}`,
      });
    }
  }

  if (failures.length > 0) {
    console.error('\nScheduler-target validation FAILED:');
    for (const f of failures) console.error(`  - ${f.job}: ${f.reason} (uri: ${f.uri})`);
    process.exit(1);
  }
  console.log('Scheduler-target validation passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
