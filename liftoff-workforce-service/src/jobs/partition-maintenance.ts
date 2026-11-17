// Tick pg_partman's maintenance for this database.
//
// partman creates the next months and applies retention when
// `run_maintenance()` runs; on Cloud SQL its background worker is unavailable,
// so something external has to call it. This job is that caller, on a Cloud
// Scheduler cron.
//
// It runs with the migration role rather than the application role: creating
// and attaching a partition requires ownership of the parent table, and the
// service's own pool is deliberately not an owner.
//
// Idempotent and safe to run at any frequency — partman only creates what is
// missing. The premake window plus the DEFAULT partition mean a missed tick
// costs nothing; this is the mechanism that keeps the runway ahead, not a
// last line of defence.

import { Client } from 'pg';

interface PartitionRow {
  parent_table: string;
  partitions: number;
  newest_bound: string | null;
}

function connectionString(): string {
  const user = process.env['DB_USER'];
  const password = process.env['DB_PASSWORD'];
  const name = process.env['DB_NAME'];
  const socket = process.env['CLOUD_SQL_CONNECTION_NAME'];
  if (!user || !password || !name || !socket) {
    throw new Error(
      'DB_USER, DB_PASSWORD, DB_NAME and CLOUD_SQL_CONNECTION_NAME are all required',
    );
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@/${name}?host=/cloudsql/${socket}`;
}

async function coverage(client: Client): Promise<PartitionRow[]> {
  const { rows } = await client.query<PartitionRow>(`
    SELECT
      cfg.parent_table,
      count(i.inhrelid)::int AS partitions,
      max(pg_get_expr(c.relpartbound, c.oid)) AS newest_bound
    FROM partman.part_config cfg
    JOIN pg_inherits i ON i.inhparent = cfg.parent_table::regclass
    JOIN pg_class c ON c.oid = i.inhrelid
    GROUP BY cfg.parent_table
  `);
  return rows;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const before = await coverage(client);
    if (before.length === 0) {
      // Nothing registered means the migration that hands a table to partman
      // has not run. Fail rather than report a clean tick that maintained
      // nothing.
      throw new Error('partman.part_config is empty — no table is under partition management');
    }

    await client.query('SELECT partman.run_maintenance(p_analyze := false)');

    const after = await coverage(client);
    for (const row of after) {
      const was = before.find(b => b.parent_table === row.parent_table);
      console.log(
        JSON.stringify({
          msg: 'partition maintenance complete',
          parent: row.parent_table,
          partitions: row.partitions,
          created: row.partitions - (was?.partitions ?? 0),
          newestBound: row.newest_bound,
        }),
      );
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ msg: 'partition maintenance failed', error: (err as Error).message }));
  process.exit(1);
});
