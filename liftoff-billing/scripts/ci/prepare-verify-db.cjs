// Creates the roles the migration chain GRANTs to, so a bare Postgres container
// can run it.
//
// Migration 008 grants to `billing_app` and `billing_readonly` and sets default
// privileges FOR ROLE `billing_migrate`. All three exist in Cloud SQL and in
// none of the throwaway containers the verification runs against, so without
// this the chain dies on a missing role — a result that says nothing at all
// about the SQL, while looking exactly like one that does.
//
// NOLOGIN on purpose: nothing here authenticates as them. They exist so the
// GRANTs have a grantee.
//
// Idempotent, and quiet about it: a developer's local Postgres usually has them
// already from an earlier run.

const { Client } = require('pg');

const ROLES = ['billing_app', 'billing_readonly', 'billing_migrate'];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('prepare-verify-db: DATABASE_URL is required');
    process.exit(2);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const role of ROLES) {
      // DO/EXCEPTION rather than a pre-check: two verification runs against the
      // same server can race, and duplicate_object is the only answer that
      // matters.
      await client.query(
        `DO $$
         BEGIN
           CREATE ROLE ${role} NOLOGIN;
         EXCEPTION WHEN duplicate_object THEN NULL;
         END $$`,
      );
    }
    console.log(`prepare-verify-db: roles ready (${ROLES.join(', ')})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`prepare-verify-db: ${err.message}`);
  process.exit(2);
});
