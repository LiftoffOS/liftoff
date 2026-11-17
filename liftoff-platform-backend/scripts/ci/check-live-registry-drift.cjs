#!/usr/bin/env node
//
// The LIVE registry and the migration chain must give the same answer.
//
// This is the half `check-registry-drift.sh` cannot see. That gate runs against
// a database rebuilt from empty, so it reads the chain's output and compares it
// to the code — which catches a window that is MISSING and, by construction,
// can never catch one that is WRONG in a real environment. A value a migration
// owns can be overwritten afterwards by something that is not a migration, and
// from then on the rebuilt database and the live one disagree forever with
// nothing comparing them.
//
// The worked example: a live window of 2,000,000 tokens where the same
// migrations rebuilt say 1,000,000 parks the guard that reads it at 1,400,000 —
// above the model's real window, unable to fire at all. A pricing sync that
// wrote a gateway's figure while a vendor was reached through that gateway, and
// stopped selecting the rows once the vendor moved to `transport: 'direct'`,
// leaves exactly that stale number with no owner, and every gate stays green.
//
// WHERE IT RUNS, and why there. The migrate Cloud Run job is the only place in
// the pipeline that can reach a live database — it is in the VPC with the
// Cloud SQL socket mounted — and it runs on EVERY deploy, before the service is
// deployed. So the comparison happens against the database the code is about to
// serve, at the moment the chain has just finished applying.
//
// WHY IT BLOCKS. A migration edited after it ran leaves a rebuild and the live
// databases disagreeing, with nothing comparing them. A report does not fix
// that — nobody reads a log line as a gate. The remedy for a real divergence is one idempotent migration
// that records the value the environment should hold, which is the same remedy
// the repo already prescribes for an edited migration.
//
// WHAT IT DOES NOT BLOCK, deliberately:
//
//   * Providers the pricing sync sizes at runtime. Their live value is MEANT to
//     move; the baseline excludes them at generation time, from the vendor map
//     that defines them.
//   * A model the chain sized that the live database does not carry at all, and
//     a live row the chain never sized. Both are reported loudly and neither
//     fails: they are a different question (does the row exist) from the one
//     this answers (does the row agree), and a gate that fails on its own
//     edges gets switched off rather than fixed.
//   * Anything at all when the baseline is missing or unreadable. An
//     inconclusive check knows nothing, and says so.
//
// Escape hatch: REGISTRY_DRIFT_GATE=report downgrades a real divergence to a
// loud report. It exists because a gate with no documented way past it gets
// removed the first time it is inconvenient — the same reasoning as
// SKIP_DEP_INTEGRITY=1. A run under it proves nothing about the registry.
//
// Exit codes mirror the other registry gates:
//   0  the live registry agrees with the chain (or the check could not run)
//   1  a migration-owned window has been changed by something else — block

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BASELINE = process.env.REGISTRY_BASELINE_PATH
  || path.join(__dirname, '..', '..', 'registry-baseline.json');

/**
 * The decision, with no database and no process in it: which migration-owned
 * windows this database disagrees with, and which it does not carry at all.
 *
 * Separated from the I/O so the rule that BLOCKS A DEPLOY is covered by the
 * ordinary unit suite. A gate whose logic can only be exercised by running the
 * pipeline is a gate nobody can change safely.
 *
 * `liveRows` are raw `models` rows (`provider`, `model_id`, `context_window`);
 * pg hands back bigint-ish columns as strings on some drivers, so the recorded
 * value is normalised before it is compared and a NULL stays NULL rather than
 * becoming 0.
 */
function compareRegistry(baseline, liveRows) {
  const liveByKey = new Map(liveRows.map((r) => [`${r.provider}|${r.model_id}`, r]));
  const drifted = [];
  const absent = [];
  for (const want of baseline.models) {
    const got = liveByKey.get(`${want.provider}|${want.modelId}`);
    if (!got) {
      absent.push(want);
      continue;
    }
    const recorded = got.context_window === null || got.context_window === undefined
      ? null
      : Number(got.context_window);
    if (recorded !== want.contextWindow) drifted.push({ want, recorded });
  }
  return { drifted, absent };
}

function inconclusive(why) {
  console.log('############################################################');
  console.log('# live registry drift check could NOT RUN.');
  console.log(`# ${why}`);
  console.log('# Not failing: an inconclusive check knows nothing.');
  console.log('############################################################');
  process.exit(0);
}

async function main() {
  if (!fs.existsSync(BASELINE)) {
    inconclusive(`No baseline at ${BASELINE} — it is built by dump-registry-baseline.cjs.`);
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch (error) {
    inconclusive(`The baseline could not be parsed — ${error.message}`);
  }
  if (!Array.isArray(baseline.models) || baseline.models.length === 0) {
    inconclusive('The baseline names no migration-owned windows.');
  }

  const url = process.env.DATABASE_URL;
  if (!url) inconclusive('DATABASE_URL is not set.');

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    inconclusive(`Could not connect to the live database — ${error.message}`);
  }

  let live;
  try {
    ({ rows: live } = await client.query('SELECT provider, model_id, context_window FROM models'));
  } catch (error) {
    await client.end();
    inconclusive(`Could not read the live registry — ${error.message}`);
  }
  await client.end();

  const { drifted, absent } = compareRegistry(baseline, live);

  console.log(
    `live registry drift: compared ${baseline.models.length} migration-owned windows `
    + `against ${live.length} live rows (baseline from ${baseline.migrationsApplied} migrations, `
    + `generated ${baseline.generatedAt}).`,
  );
  if (baseline.syncOwnedProviders?.length) {
    console.log(`live registry drift: not compared — sized at runtime by the pricing sync: ${baseline.syncOwnedProviders.join(', ')}`);
  }
  for (const a of absent) {
    console.log(`live registry drift: NOTE — ${a.provider}/${a.modelId} is sized by a migration but has no live row.`);
  }

  if (drifted.length === 0) {
    console.log('live registry drift: OK — every migration-owned window is the value the chain records.');
    process.exit(0);
  }

  console.error('############################################################');
  console.error('# LIVE REGISTRY DRIFT');
  console.error('#');
  console.error('# A context window a migration owns holds a different value in');
  console.error('# this database. The chain and this environment now disagree, and');
  console.error('# the live value is what every turn bound is taken from.');
  console.error('#');
  for (const { want, recorded } of drifted) {
    console.error(`#   ${want.provider}/${want.modelId}`);
    console.error(`#     migrations say : ${want.contextWindow}`);
    console.error(`#     this database  : ${recorded === null ? 'NULL' : recorded}`);
  }
  console.error('#');
  console.error('# Two writers besides a migration can set this column: the pricing');
  console.error('# sync (only for the providers listed above) and');
  console.error('# PUT /api/model-registry/:id/context-window.');
  console.error('#');
  console.error('# The fix is one idempotent migration recording the value this');
  console.error('# environment should hold, scoped to the value it is replacing, e.g.');
  for (const { want, recorded } of drifted) {
    console.error('#');
    console.error('#   UPDATE models SET context_window = <the vendor\'s figure>, updated_at = NOW()');
    console.error(`#    WHERE provider = '${want.provider}' AND model_id = '${want.modelId}'`);
    console.error(`#      AND context_window ${recorded === null ? 'IS NULL' : `= ${recorded}`};`);
  }
  console.error('#');
  console.error('# Record the vendor\'s own figure with two agreeing sources, which is');
  console.error('# the standard migration 343 set: a window licenses a consumer to end');
  console.error('# a session on it, so a number nobody is sure of is worse than none.');
  console.error('############################################################');

  if (process.env.REGISTRY_DRIFT_GATE === 'report') {
    console.error('REGISTRY_DRIFT_GATE=report — not blocking. This deploy proves nothing about the registry.');
    process.exit(0);
  }
  process.exit(1);
}

module.exports = { compareRegistry };

// Only run when invoked as a script, so the unit suite can require the rule
// without opening a database connection or calling process.exit.
if (require.main === module) void main();
