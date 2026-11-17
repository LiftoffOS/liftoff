// Give the throwaway verification database the roles Cloud SQL already has.
//
// WHY. Several migrations GRANT to, or ALTER DEFAULT PRIVILEGES FOR, roles that
// the managed instance provides: liftoff_app and liftoff_admin are created at
// provisioning time, and cloudsqlsuperuser is Cloud SQL's own. A bare Postgres
// container has none of them, so the first GRANT dies with 42704 --
// `role "liftoff_app" does not exist` -- and the gate reports a perfectly good
// migration as broken.
//
// This is the same class as the pgvector extension: the migration is not at
// fault, the empty database is simply less furnished than the real one. The gate
// is only worth having if its database resembles the one it is protecting.
//
// It caught a developer's laptop lying, too. A local run passed while CI failed,
// because this machine had accumulated all three roles from earlier work — so
// the local check was answering a question about a database nobody else has.
//
// NOLOGIN and no privileges on purpose: these exist so GRANT has a grantee, not
// so anything can connect as them. The database is deleted either way.

const { Client } = require('pg');

const ROLES = ['liftoff_admin', 'liftoff_app', 'cloudsqlsuperuser'];

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const created = [];
  for (const role of ROLES) {
    // CREATE ROLE has no IF NOT EXISTS. The catalog check and the create are not
    // atomic, so a concurrent creator can still win the race — 42710 means the
    // role is there, which is the outcome we wanted.
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rows.length > 0) continue;
    try {
      await client.query(`CREATE ROLE ${client.escapeIdentifier(role)} NOLOGIN`);
      created.push(role);
    } catch (err) {
      if (err.code !== '42710') throw err;
    }
  }

  await client.end();
  console.log(
    created.length > 0
      ? `prepare-verify-db: created ${created.join(', ')}`
      : 'prepare-verify-db: all roles already present',
  );
})().catch((err) => {
  console.error(`prepare-verify-db: ${err.message}`);
  process.exit(1);
});
