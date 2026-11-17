// Phase 0i — dynamic partition provisioning for billing_audit_log.
// Ensures the next `monthsAhead` months exist as attached partitions
// and applies the hash-chain BEFORE-INSERT trigger from migration 004.
//
// Run at every deploy (cloudbuild.yaml) AND via a daily Cloud
// Scheduler job that catches gaps between deploys (terraform
// schedules `billing-partitions-${env}`).

import type { Pool } from 'pg';
import { getPool } from '../infrastructure/database.js';

const DEFAULT_MONTHS_AHEAD = 18;

export interface ProvisionResult {
  created: string[];
  existing: string[];
}

export async function provisionPartitions(
  monthsAhead: number = DEFAULT_MONTHS_AHEAD,
  pool?: Pool,
): Promise<ProvisionResult> {
  // rls-fence: allow
  const p = pool ?? (await getPool());
  const client = await p.connect();
  const created: string[] = [];
  const existing: string[] = [];

  try {
    for (let i = 0; i < monthsAhead; i++) {
      const target = addMonths(firstOfCurrentMonth(), i);
      const next = addMonths(target, 1);
      const partitionName = partitionNameFor(target);
      const rangeFrom = formatYmd01(target);
      const rangeTo = formatYmd01(next);

      // Check whether partition already exists.
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = $1 AND n.nspname = 'public'
         ) AS exists`,
        [partitionName],
      );
      if (rows[0].exists) {
        existing.push(partitionName);
        continue;
      }

      await client.query(
        `CREATE TABLE ${partitionName}
         PARTITION OF billing_audit_log
         FOR VALUES FROM ('${rangeFrom}') TO ('${rangeTo}')`,
      );
      // Attach the hash-chain trigger from migration 004 — but only if it is
      // not already there. On PG 12+ a row trigger on the partitioned parent is
      // cloned onto every new partition automatically, so CREATE TABLE ...
      // PARTITION OF above has already installed it and an unconditional CREATE
      // TRIGGER raises 42710 (duplicate_object). Migration 004 hits the same
      // case and swallows it with EXCEPTION WHEN duplicate_object; this did
      // not, so provisioning aborted on the first partition it actually
      // created. The guard keeps the PG 11 path working, where the parent
      // trigger does not propagate and this CREATE is the one that installs it.
      const { rows: trg } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           WHERE c.relname = $1
             AND t.tgname = 'billing_audit_log_fill_hash_chain'
             AND NOT t.tgisinternal
         ) AS exists`,
        [partitionName],
      );
      if (!trg[0].exists) {
        await client.query(
          `CREATE TRIGGER billing_audit_log_fill_hash_chain
             BEFORE INSERT ON ${partitionName}
             FOR EACH ROW
             EXECUTE FUNCTION billing_audit_log_fill_hash_chain()`,
        );
      }
      created.push(partitionName);
    }
  } finally {
    client.release();
  }
  return { created, existing };
}

function firstOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function formatYmd01(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function partitionNameFor(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `billing_audit_log_y${y}_m${m}`;
}

// CLI entry — invoked from cloudbuild + Cloud Scheduler.
if (process.argv[1]?.endsWith('partitions/provision.js')) {
  const months = Number(process.env.MONTHS_AHEAD ?? String(DEFAULT_MONTHS_AHEAD));
  provisionPartitions(months).then((r) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[partitions] failed', err);
    process.exit(1);
  });
}
