// The purge pass: what makes "deleted" eventually true.
//
// Deletion in this service is a two-step contract. The first step is
// immediate and is what the person sees: the row gets `deleted_at` and
// disappears from every read, every list and every export. The second step is
// this pass, which hard-deletes the row once its grace period has elapsed.
// Until it existed, only the first step ran: `deleted_at` was written and
// nothing ever removed the row, so an agent a workspace deleted kept its
// definition, its prompts, every version snapshot and the conversations it
// took part in, indefinitely, and the "GDPR deletion" endpoint in
// src/data-management did the same thing under a name that promised more.
//
// Two properties this pass is built around.
//
// IT RUNS WITHOUT BEING WIRED UP. A purge that only fires from a scheduler is
// a privacy promise that depends on the operator having configured one, and
// the failure is silent in the worst direction: the product says "deleted",
// the scheduler was never created, the rows stay forever and nothing reports
// it. So `startPurgeWorker` runs in-process on every instance, and the
// maintenance route is the second way in rather than the only one. A Postgres
// advisory lock means N instances running it is the same as one.
//
// THE LIST IS RATCHETED, NOT TRUSTED. The tables are enumerated explicitly
// below rather than discovered from the catalog, because a blind
// `DELETE FROM <every table with a deleted_at>` cannot know that an account
// also has state in Stripe and Firebase, or that a conversation has to go
// whole. The cost of an explicit list is that it rots the moment somebody
// soft-deletes a new table, which is this repo's dominant defect class — so
// purge-coverage.test.ts fails the build when a `SET deleted_at = NOW()`
// appears for a table that is not listed here.

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

/**
 * How long a soft-deleted row survives before the purge takes it.
 *
 * Thirty days by default, which is the window the grace period is for: an
 * operator restoring a workspace's mistake, and a support conversation that
 * takes a week to reach somebody. Shorter is a stronger privacy posture and
 * entirely reasonable to set; 0 is rejected rather than honoured, because a
 * purge that runs before the person has finished reading the confirmation
 * dialog turns every misclick into unrecoverable loss.
 */
export const PURGE_AFTER_DAYS = (() => {
  const raw = process.env.SOFT_DELETE_PURGE_AFTER_DAYS;
  if (raw === undefined || raw.trim() === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    log.warn(
      { SOFT_DELETE_PURGE_AFTER_DAYS: raw },
      'purge: SOFT_DELETE_PURGE_AFTER_DAYS must be a number of days >= 1 — falling back to 30',
    );
    return 30;
  }
  return Math.floor(n);
})();

/** One purge at a time across every instance. Arbitrary but fixed. */
const PURGE_LOCK_KEY = 8_241_077;

/**
 * Tables purged by the generic sweep, children before parents.
 *
 * Order matters only where one table references another with no cascade; the
 * agent and account entries are handled separately below because they need
 * more than a DELETE. Every entry carries why it is here, because "which
 * tables hold a deleted person's data" is the question this file exists to
 * answer and a bare list does not answer it.
 */
export const PURGE_TABLES: ReadonlyArray<{ table: string; why: string }> = [
  // Conversation content. Threads cascade to their own messages and
  // participants, so the thread row is the only one that needs naming.
  { table: 'agent_chat_threads', why: 'a conversation with an AI team, with its messages' },
  { table: 'liftoff_chat_threads', why: "the Liftoff assistant's conversations" },
  { table: 'insights_chat_threads', why: "the Insights Manager's conversations" },

  // Assignments are polymorphic (internal or external agent) and carry no FK,
  // so nothing cascades them; they name a person and an agent.
  { table: 'person_agent_assignments', why: 'which person worked with which agent' },

  // Credentials a person registered. The row keeps a client id and a
  // registration token hash after revocation.
  { table: 'oauth_clients', why: 'an MCP client a person registered' },
  // Marked when somebody is removed from a workspace, and nothing removed it
  // afterwards. The OAuth access and refresh tokens anchored on it are swept
  // far sooner (expired an hour, revoked seven days, in this same module);
  // the anchor row itself was the one that stayed.
  { table: 'mcp_tokens', why: "a coding tool's workspace credential, already revoked" },

  // External collaborators: the agent definition and its endpoint.
  { table: 'external_agents', why: 'an external collaborator a workspace connected' },

  // The entity tables src/data-management soft-deletes on a retention or
  // erasure request. Listed after the above so a workflow's children are
  // already gone.
  { table: 'workflows', why: 'retention or erasure request (data-management)' },
  { table: 'actions', why: 'retention or erasure request (data-management)' },
  { table: 'usage_events', why: 'retention or erasure request (data-management)' },
  { table: 'connector_records', why: 'retention or erasure request (data-management)' },
  { table: 'reflections', why: 'retention or erasure request (data-management)' },
  { table: 'feedback_requests', why: 'retention or erasure request (data-management)' },
  { table: 'audit_log', why: 'retention request (data-management); erasure never targets it' },
];

export interface PurgeSummary {
  dryRun: boolean;
  olderThanDays: number;
  /** Rows removed (or that would be) per table. */
  perTable: Record<string, number>;
  /** Agents purged, and the conversations removed with them. */
  agentsPurged: number;
  agentThreadsPurged: number;
  /** Accounts handed to the full cascade, and how many completed. */
  accountsPurged: number;
  accountsFailed: number;
  /** A table that could not be swept, and why. Never thrown: see below. */
  skipped: Array<{ table: string; reason: string }>;
  /** False when another instance held the lock, in which case nothing ran. */
  ran: boolean;
}

/**
 * Hard-delete every soft-deleted row whose grace period has elapsed.
 *
 * Resilient per table on purpose. A single table that cannot be swept -
 * absent in this database, or held by a foreign key somebody added without a
 * cascade - must not stop the other twelve, because the alternative is one
 * new constraint silently ending all purging. Failures are collected in
 * `skipped` and logged at warn, so they surface rather than pass.
 */
export async function purgeSoftDeleted(opts: {
  dryRun?: boolean;
  olderThanDays?: number;
} = {}): Promise<PurgeSummary> {
  const dryRun = opts.dryRun === true;
  const days = opts.olderThanDays ?? PURGE_AFTER_DAYS;

  const summary: PurgeSummary = {
    dryRun,
    olderThanDays: days,
    perTable: {},
    agentsPurged: 0,
    agentThreadsPurged: 0,
    accountsPurged: 0,
    accountsFailed: 0,
    skipped: [],
    ran: false,
  };

  const accountIdsToCascade: string[] = [];

  await withAdminScope(
    { caller: 'purgeSoftDeleted', reason: 'cross-tenant hard delete of expired soft-deleted rows' },
    async (client) => {
      const locked = (await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PURGE_LOCK_KEY],
      )).rows[0]?.locked === true;
      if (!locked) {
        log.debug('purge: another instance holds the lock — skipping this tick');
        return;
      }
      summary.ran = true;

      try {
        // Agents first, and as a unit. An agent's conversations are deleted
        // by thread so a conversation goes whole: cascading
        // agent_chat_thread_participants alone would remove the agent from
        // the thread and leave the person's half of the exchange behind,
        // which is a worse outcome than not purging at all - it reads as a
        // conversation with nobody.
        const expiredAgents = (await client.query<{ id: string }>(
          `SELECT id FROM internal_agents
            WHERE deleted_at IS NOT NULL
              AND deleted_at < NOW() - make_interval(days => $1)`,
          [days],
        )).rows.map((r) => r.id);

        if (expiredAgents.length > 0) {
          const threads = await client.query<{ id: string }>(
            `SELECT DISTINCT thread_id AS id
               FROM agent_chat_thread_participants
              WHERE agent_id = ANY($1::uuid[])`,
            [expiredAgents],
          );
          summary.agentThreadsPurged = threads.rowCount ?? 0;
          if (!dryRun && summary.agentThreadsPurged > 0) {
            await client.query(
              `DELETE FROM agent_chat_threads WHERE id = ANY($1::uuid[])`,
              [threads.rows.map((r) => r.id)],
            );
          }
          // Polymorphic, no FK, so it does not cascade with the agent.
          if (!dryRun) {
            await client.query(
              `DELETE FROM person_agent_assignments WHERE agent_id = ANY($1::uuid[])`,
              [expiredAgents],
            );
          }
          if (dryRun) {
            summary.agentsPurged = expiredAgents.length;
          } else {
            // Migration 566 made the seven blocking foreign keys cascade, so
            // this removes the versions, the skills metrics, the generated
            // files, the share links and the rest with the row.
            const del = await client.query(
              `DELETE FROM internal_agents WHERE id = ANY($1::uuid[])`,
              [expiredAgents],
            );
            summary.agentsPurged = del.rowCount ?? 0;
          }
        }

        // The generic sweep.
        for (const { table } of PURGE_TABLES) {
          try {
            const reg = (await client.query<{ exists: boolean }>(
              'SELECT to_regclass($1) IS NOT NULL AS exists',
              [table],
            )).rows[0]?.exists === true;
            if (!reg) {
              summary.skipped.push({ table, reason: 'table not present in this database' });
              continue;
            }
            const hasCol = (await client.query<{ exists: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = $1
                    AND column_name = 'deleted_at'
               ) AS exists`,
              [table],
            )).rows[0]?.exists === true;
            if (!hasCol) {
              summary.skipped.push({ table, reason: 'no deleted_at column' });
              continue;
            }

            // Identifier is from PURGE_TABLES, a module constant, never from
            // a request - but it is still quoted rather than interpolated raw.
            const sql = dryRun
              ? `SELECT COUNT(*)::int AS n FROM "${table}"
                  WHERE deleted_at IS NOT NULL
                    AND deleted_at < NOW() - make_interval(days => $1)`
              : `DELETE FROM "${table}"
                  WHERE deleted_at IS NOT NULL
                    AND deleted_at < NOW() - make_interval(days => $1)`;
            const r = await client.query(sql, [days]);
            summary.perTable[table] = dryRun
              ? ((r.rows[0] as { n: number } | undefined)?.n ?? 0)
              : (r.rowCount ?? 0);
          } catch (err) {
            const reason = (err as Error).message;
            summary.skipped.push({ table, reason });
            log.warn({ table, error: reason }, 'purge: table could not be swept');
          }
        }

        // Accounts are not a DELETE. An account has state outside this
        // database - a Stripe customer and a Firebase user - so purging one
        // means running the same cascade the person's own deletion runs.
        // Collected here and executed outside the admin transaction, because
        // cascadeDelete opens its own.
        const expiredAccounts = await client.query<{ id: string }>(
          `SELECT id FROM accounts
            WHERE deleted_at IS NOT NULL
              AND deleted_at < NOW() - make_interval(days => $1)`,
          [days],
        );
        accountIdsToCascade.push(...expiredAccounts.rows.map((r) => r.id));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]);
      }
    },
  );

  if (summary.ran && accountIdsToCascade.length > 0) {
    if (dryRun) {
      summary.accountsPurged = accountIdsToCascade.length;
    } else {
      const { AccountService } = await import('../accounts/service');
      const accounts = new AccountService();
      for (const id of accountIdsToCascade) {
        try {
          const r = await accounts.cascadeDelete(id, 'purge-soft-deleted', {
            dryRun: false,
            // Same mode the person's own deletion uses: strip the PII from
            // the Stripe customer and keep the hashed ledger row, rather
            // than deleting a customer whose invoices must survive.
            scrubMode: 'soft',
          });
          if (r.accountRowDeleted) summary.accountsPurged += 1;
          else summary.accountsFailed += 1;
        } catch (err) {
          summary.accountsFailed += 1;
          log.warn(
            { accountId: id, error: (err as Error).message },
            'purge: account cascade failed — row stays for the next pass',
          );
        }
      }
    }
  }

  if (summary.ran) {
    const rows = Object.values(summary.perTable).reduce((a, b) => a + b, 0);
    log.info(
      {
        dryRun,
        olderThanDays: days,
        rows,
        agentsPurged: summary.agentsPurged,
        agentThreadsPurged: summary.agentThreadsPurged,
        accountsPurged: summary.accountsPurged,
        accountsFailed: summary.accountsFailed,
        skipped: summary.skipped.length,
      },
      'purge: pass complete',
    );
  }

  return summary;
}

let purgeTimer: NodeJS.Timeout | null = null;

/**
 * Run the purge in-process, for ever, on every instance.
 *
 * This is the part that makes the deletion promise hold for somebody who
 * deployed this service and configured nothing else. Twice a day is ample for
 * a thirty-day window and keeps each pass small; the advisory lock makes the
 * instance count irrelevant.
 *
 * THERE IS DELIBERATELY NO WAY TO TURN THIS OFF. A switch would recreate the
 * state this pass exists to end - rows marked deleted and never removed -
 * and would do it silently, because the product goes on reporting the
 * deletion either way and the only trace would be a line in a boot log. An
 * operator who wants a different cadence has SOFT_DELETE_PURGE_INTERVAL_HOURS
 * and can force a pass through the maintenance route; neither stops the pass
 * from running.
 */
export function startPurgeWorker(): void {
  if (purgeTimer) return;

  const hours = Number(process.env.SOFT_DELETE_PURGE_INTERVAL_HOURS ?? 12);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;

  const tick = () => {
    purgeSoftDeleted().catch((err) =>
      log.error({ error: (err as Error).message }, 'purge: pass failed'),
    );
  };

  // Not at boot: a deploy restarts every instance at once, and a cold start
  // has a migration to finish and traffic to serve before it owes anybody a
  // retention sweep.
  setTimeout(tick, 5 * 60_000).unref?.();
  purgeTimer = setInterval(tick, intervalMs);
  purgeTimer.unref?.();

  log.info(
    { intervalHours: intervalMs / 3_600_000, purgeAfterDays: PURGE_AFTER_DAYS },
    'purge: in-process worker started',
  );
}

export function stopPurgeWorker(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
