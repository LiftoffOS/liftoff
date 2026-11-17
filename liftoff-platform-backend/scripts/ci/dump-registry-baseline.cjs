#!/usr/bin/env node
//
// What the migration chain SAYS the registry holds — dumped from a database
// that has just been rebuilt from empty, so it is the chain's own answer and
// not a second copy of it maintained by hand.
//
// WHY THIS EXISTS. `check-registry-drift.sh` asserts that every reachable model
// carries a context window. It runs against a FRESHLY MIGRATED database, which
// is what lets it read SQL the unit suite cannot — and is also its blind spot:
// a freshly migrated database is the chain's output by construction, so the
// gate can see a window that is MISSING and never one that is WRONG.
//
// The risk is concrete: a live window can sit at 2,000,000 tokens against a
// vendor's documented 1,000,000 while a database rebuilt from the same
// migrations says 1,000,000. Two answers to one question, in different places,
// with nothing comparing them — and the wrong one puts the turn guard at
// 1,400,000 tokens, ABOVE the real window, where it can never fire. Nothing
// fails for as long as that is true.
//
// Such a number need not be hand-written. A pricing sync can write it from a
// gateway's catalog while a vendor is reached through it; if the vendor later
// moves to `transport: 'direct'`, the sync stops selecting the rows, and a
// figure that belonged to a gateway no longer called freezes with no owner left
// to correct it. THAT is the class: a value a migration owns, changed by something else,
// years from anyone noticing.
//
// So the baseline is the chain's output, captured where it already exists (the
// migration gate's throwaway Postgres) and carried into the migrate job, which
// is the one place in the pipeline that can see a LIVE database. The comparison
// lives in check-live-registry-drift.cjs.
//
// WHAT IS IN IT, and what is deliberately not:
//
//   * Only models whose window a MIGRATION recorded. Rows belonging to
//     `OPENROUTER_HOSTED_PROVIDERS` are sized at runtime by the pricing sync
//     from the gateway's endpoints API, so their live value is SUPPOSED to
//     differ from a freshly migrated one and comparing them would report drift
//     on every deploy forever. The list is read from the code that defines it,
//     never restated here — it is derived from each vendor's `transport`, and
//     a vendor that changes transport changes this set with it.
//   * Only rows that actually carry a window. A NULL is the OTHER gate's
//     business and reporting it here would name one defect twice.
//
// Usage: DATABASE_URL=postgres://... node scripts/ci/dump-registry-baseline.cjs [out]

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT = process.argv[2] || path.join(__dirname, '..', '..', 'registry-baseline.json');

/** The providers the pricing sync sizes at runtime, read from the module that
 *  derives them, so this cannot drift from the sync's own behaviour. */
function syncOwnedProviders() {
  // The compiled module: this runs in CI after the `build` step, beside the
  // gate that already requires the workspace packages to be built.
  const compiled = path.join(__dirname, '..', '..', 'dist', 'model-registry', 'workspace-ai-vendors.js');
  const mod = require(compiled);
  const list = mod.OPENROUTER_HOSTED_PROVIDERS;
  if (!Array.isArray(list)) {
    throw new Error('OPENROUTER_HOSTED_PROVIDERS is not an array — the baseline would exclude nothing');
  }
  return [...list];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('dump-registry-baseline: DATABASE_URL is required (a database with every migration applied)');
    process.exit(2);
  }

  let owned;
  try {
    owned = syncOwnedProviders();
  } catch (error) {
    console.error(`dump-registry-baseline: could not read the sync-owned provider list — ${error.message}`);
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    console.error(`dump-registry-baseline: could not connect — ${error.message}`);
    process.exit(2);
  }

  try {
    const { rows: applied } = await client.query('SELECT COUNT(*)::int AS n FROM pgmigrations');
    const { rows } = await client.query(
      `SELECT provider, model_id, status, context_window
         FROM models
        WHERE context_window IS NOT NULL
          AND NOT (provider = ANY($1))
        ORDER BY provider, model_id`,
      [owned],
    );

    const baseline = {
      // Stamped so a stale baseline is visible rather than silently believed.
      generatedAt: new Date().toISOString(),
      migrationsApplied: applied[0].n,
      syncOwnedProviders: owned,
      models: rows.map((r) => ({
        provider: r.provider,
        modelId: r.model_id,
        status: r.status,
        contextWindow: Number(r.context_window),
      })),
    };

    fs.writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `dump-registry-baseline: wrote ${baseline.models.length} migration-owned windows `
      + `from ${baseline.migrationsApplied} migrations to ${OUT}`,
    );
    if (owned.length > 0) {
      console.log(`dump-registry-baseline: excluded the sync-owned providers ${owned.join(', ')}`);
    }
  } catch (error) {
    console.error(`dump-registry-baseline: ${error.message}`);
    process.exit(2);
  } finally {
    await client.end();
  }
}

void main();
