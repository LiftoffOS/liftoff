/**
 * tools/migration/setup-logical-replication.ts
 *
 * Sets up Postgres logical replication from the platform-backend DB (source)
 * for the workforce_plans table.  Run this once at the start of the cut-over
 * window; then run the printed CREATE SUBSCRIPTION command on the target DB.
 *
 * Env vars:
 *   PG_SOURCE_URL       – source DB connection string (needs REPLICATION privilege
 *                         or superuser; also used as regular client for DDL)
 *   SLOT_NAME           – replication slot name (default: workforce_plans_migration)
 *   PUBLICATION_NAME    – publication name (default: workforce_plans_pub)
 *
 * Usage:
 *   npx tsx tools/migration/setup-logical-replication.ts
 */

import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PG_SOURCE_URL = process.env['PG_SOURCE_URL'];
const SLOT_NAME = process.env['SLOT_NAME'] ?? 'workforce_plans_migration';
const PUBLICATION_NAME = process.env['PUBLICATION_NAME'] ?? 'workforce_plans_pub';

if (!PG_SOURCE_URL) {
  console.error('ERROR: PG_SOURCE_URL is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the error looks like a "already exists" duplicate from Postgres.
 * Postgres error code 42710 = duplicate_object.
 */
function isDuplicateObjectError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '42710'
  );
}

/**
 * Returns true if the error looks like a replication slot "already exists" error.
 * Postgres raises this with code 42710 as well, but let's also check message text
 * as a belt-and-suspenders check.
 */
function isSlotAlreadyExistsError(err: unknown): boolean {
  if (!isDuplicateObjectError(err)) return false;
  const msg =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: string }).message)
      : '';
  return msg.toLowerCase().includes('replication slot') || msg === '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[setup-logical-replication] Connecting to source DB…');
  console.log(`[setup-logical-replication]   SLOT_NAME        = ${SLOT_NAME}`);
  console.log(`[setup-logical-replication]   PUBLICATION_NAME = ${PUBLICATION_NAME}`);

  const source = new Client({ connectionString: PG_SOURCE_URL });
  await source.connect();

  try {
    // -----------------------------------------------------------------------
    // Step 1: Create publication
    // -----------------------------------------------------------------------
    console.log(`\n[setup-logical-replication] Creating publication "${PUBLICATION_NAME}"…`);
    try {
      await source.query(
        `CREATE PUBLICATION ${PUBLICATION_NAME} FOR TABLE workforce_plans`,
      );
      console.log(`[setup-logical-replication]   Publication "${PUBLICATION_NAME}" created.`);
    } catch (err: unknown) {
      if (isDuplicateObjectError(err)) {
        console.log(
          `[setup-logical-replication]   Publication "${PUBLICATION_NAME}" already exists — skipping.`,
        );
      } else {
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Create replication slot
    // -----------------------------------------------------------------------
    console.log(`\n[setup-logical-replication] Creating replication slot "${SLOT_NAME}"…`);

    let slotLsn: string | null = null;

    try {
      const slotRes = await source.query<{ lsn: string }>(
        `SELECT lsn FROM pg_create_logical_replication_slot($1, 'pgoutput')`,
        [SLOT_NAME],
      );
      slotLsn = slotRes.rows[0]?.lsn ?? null;
      console.log(`[setup-logical-replication]   Slot "${SLOT_NAME}" created.`);
      console.log(`[setup-logical-replication]   Slot LSN: ${slotLsn ?? '(unknown)'}`);
    } catch (err: unknown) {
      if (isSlotAlreadyExistsError(err)) {
        console.log(
          `[setup-logical-replication]   Slot "${SLOT_NAME}" already exists — fetching current LSN.`,
        );
        // Fetch LSN from pg_replication_slots
        const existing = await source.query<{ restart_lsn: string }>(
          `SELECT restart_lsn FROM pg_replication_slots WHERE slot_name = $1`,
          [SLOT_NAME],
        );
        slotLsn = existing.rows[0]?.restart_lsn ?? null;
        console.log(`[setup-logical-replication]   Existing slot LSN: ${slotLsn ?? '(unknown)'}`);
      } else {
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Print subscription instructions
    // -----------------------------------------------------------------------

    // Parse connection string to build a safe display version
    // (strip password from display for safety)
    let displaySourceUrl = PG_SOURCE_URL ?? '';
    try {
      const u = new URL(PG_SOURCE_URL ?? '');
      u.password = '***';
      displaySourceUrl = u.toString();
    } catch {
      // leave as-is if not parseable
    }

    console.log(`
[setup-logical-replication] ===== Setup complete =====

  Publication : ${PUBLICATION_NAME}
  Slot name   : ${SLOT_NAME}
  Slot LSN    : ${slotLsn ?? '(unavailable)'}

  Next step — run the following SQL on the TARGET (workforce-service) database:

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  CREATE SUBSCRIPTION workforce_plans_sub                                │
  │    CONNECTION '<TARGET_SEES_SOURCE_URL>'                                │
  │    PUBLICATION ${PUBLICATION_NAME.padEnd(40)}       │
  │    WITH (slot_name = '${SLOT_NAME}',                                    │
  │          create_slot = false);                                          │
  └─────────────────────────────────────────────────────────────────────────┘

  Replace <TARGET_SEES_SOURCE_URL> with the connection string that the
  workforce-service DB host can reach the platform-backend DB on.  This may
  differ from PG_SOURCE_URL if the DBs are in different VPCs.

  Full CREATE SUBSCRIPTION template:

    CREATE SUBSCRIPTION workforce_plans_sub
      CONNECTION '${displaySourceUrl}'
      PUBLICATION ${PUBLICATION_NAME}
      WITH (slot_name = '${SLOT_NAME}', create_slot = false);

  Notes:
  - The target DB user needs the pg_read_all_data privilege (or equivalent).
  - The source DB user needs REPLICATION privilege.
  - wal_level on the source must be 'logical' (restart required if changed).
  - To remove replication later:
      DROP SUBSCRIPTION workforce_plans_sub;  -- on target
      SELECT pg_drop_replication_slot('${SLOT_NAME}');  -- on source
      DROP PUBLICATION ${PUBLICATION_NAME};  -- on source
`);
  } finally {
    await source.end();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('[setup-logical-replication] FATAL:', err);
  process.exit(1);
});
