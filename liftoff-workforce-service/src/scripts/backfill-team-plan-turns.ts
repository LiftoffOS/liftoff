// Give the Chief AI Officer's conversations that predate migration 031 the turn
// rows its search is keyed to, so a person's earlier planning conversations are
// findable rather than invisible.
//
// 031 created team_plan_turns empty and backfilled nothing: from that point the
// chat service stamps every new turn, so only the history needs this pass.
// Without it, "search your earlier conversations" reaches only conversations held
// after the migration, which is not what it says.
//
// THE BOUNDARY RULE, identical to the control plane's pass over Liftoff and the
// Insights Manager, because the three transcripts have the same shape:
//
//   A turn starts at each plain `role='user'` row and contains that row plus
//   every row after it until the next plain user row.
//
//   - A row carrying a `message_type` is narration, not speech (a status line, a
//     forwarded note at a delegated thread's birth, a presented file). It keeps
//     turn_id NULL and does not break a turn either, so a status line between a
//     question and its answer leaves them together.
//   - Rows before a thread's FIRST user row belong to no turn. A greeting is not
//     an exchange, and on this surface most untitled threads are greeting-only
//     shells the history modal already hides.
//
// ITS ONE KNOWN FAILURE MODE: a reply that was still running when the person sent
// another message lands after the newer message in created_at order and is grouped
// with it. Same thread, same person, seconds apart — a slightly wrong pairing in
// one excerpt, not a quote moved between conversations. Nothing in the data marks
// these, so no care here detects them.
//
// RUNS AS THE TABLE OWNER, and that is load-bearing. team_plan_threads and
// team_plan_turns carry RLS policies and are deliberately un-FORCEd (migration
// 017's warning), so workforce_migrate is exempt while workforce_app is not. A
// history repair is inherently every-tenant; as workforce_app this would read zero
// rows and report a clean run having done nothing.
//
// IDEMPOTENT. Only messages with turn_id IS NULL are considered, and each thread
// commits its turn rows and stamps in one transaction.
//
// Run as a Cloud Run Job against the workforce-service image:
//   node dist/scripts/backfill-team-plan-turns.js
// Env: BACKFILL_DRY_RUN=true  plan and count, write nothing (recommended first)
//      BACKFILL_LIMIT         max threads (default 5000)

import { randomUUID } from 'crypto';
import { getPool, initPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';

const DEFAULT_LIMIT = 5000;

interface BackfillReport {
  threadsScanned: number;
  threadsChanged: number;
  turnsCreated: number;
  messagesStamped: number;
  /** Rows no turn will EVER claim: narration, and rows before a thread's first
   *  user message. Deliberately excluded, not missed — which is why it is
   *  reported rather than left to be inferred from the table afterwards. */
  messagesExcluded: number;
  failures: number;
}

interface MessageRow {
  id: string;
  role: string;
  message_type: string | null;
  sender_account_id: string | null;
  created_at: string;
  turn_id: string | null;
}

/** One thread's messages grouped into turns by the rule in the header. Exported
 *  for the test that pins every case it decides. */
export function groupIntoTurns(rows: Array<Omit<MessageRow, 'turn_id'>>): Array<{
  senderAccountId: string | null;
  createdAt: string;
  messageIds: string[];
}> {
  const turns: Array<{ senderAccountId: string | null; createdAt: string; messageIds: string[] }> = [];
  for (const row of rows) {
    if (row.role === 'user' && row.message_type === null) {
      turns.push({ senderAccountId: row.sender_account_id, createdAt: row.created_at, messageIds: [row.id] });
      continue;
    }
    if (row.message_type !== null) continue;
    if (turns.length === 0) continue;
    turns[turns.length - 1].messageIds.push(row.id);
  }
  return turns;
}

export async function backfill(limit: number, dryRun: boolean): Promise<BackfillReport> {
  const report: BackfillReport = {
    threadsScanned: 0, threadsChanged: 0, turnsCreated: 0,
    messagesStamped: 0, messagesExcluded: 0, failures: 0,
  };
  const pool = getPool();

  const candidates = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT DISTINCT t.id, t.tenant_id
       FROM team_plan_threads t
       JOIN team_plan_messages m ON m.thread_id = t.id
      WHERE m.turn_id IS NULL
      ORDER BY t.id
      LIMIT $1`,
    [limit],
  );

  for (const thread of candidates.rows) {
    report.threadsScanned++;
    const client = await pool.connect();
    try {
      // The WHOLE thread in reading order: a turn already stamped must not be
      // reopened, and a reply cannot be grouped without the user row it answers.
      const all = await client.query<MessageRow>(
        `SELECT id, role, message_type, sender_account_id, created_at, turn_id
           FROM team_plan_messages
          WHERE thread_id = $1
          ORDER BY created_at ASC, id ASC`,
        [thread.id],
      );

      const stampedIds = new Set(all.rows.filter((r) => r.turn_id !== null).map((r) => r.id));
      const pending = groupIntoTurns(all.rows).filter(
        (t) => t.messageIds.every((id) => !stampedIds.has(id)),
      );
      if (pending.length === 0) continue;

      if (dryRun) {
        report.turnsCreated += pending.length;
        report.messagesStamped += pending.reduce((n, t) => n + t.messageIds.length, 0);
        report.threadsChanged++;
        continue;
      }

      await client.query('BEGIN');
      try {
        for (const turn of pending) {
          const turnId = randomUUID();
          await client.query(
            `INSERT INTO team_plan_turns (id, tenant_id, thread_id, account_id, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [turnId, thread.tenant_id, thread.id, turn.senderAccountId, turn.createdAt],
          );
          const stamped = await client.query(
            `UPDATE team_plan_messages SET turn_id = $1
              WHERE id = ANY($2::uuid[]) AND turn_id IS NULL`,
            [turnId, turn.messageIds],
          );
          report.turnsCreated++;
          report.messagesStamped += stamped.rowCount ?? 0;
        }
        await client.query('COMMIT');
        report.threadsChanged++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } catch (err) {
      report.failures++;
      log.error(
        { threadId: thread.id, error: (err as Error).message },
        'backfill: thread failed; continuing',
      );
    } finally {
      client.release();
    }
  }

  // What stays NULL on purpose: narration, and rows before a thread's first user
  // message. Counted so a reader can tell "left alone deliberately" from
  // "missed", which is indistinguishable in the table once the pass has run.
  //
  // SUBTRACTING THE STAMPED COUNT IS THE POINT. A plain count of turn_id IS NULL
  // is taken AFTER the writes in a real run but BEFORE them in a dry run, so in
  // dry-run mode it counts every row the pass is about to stamp as "left
  // unstamped" and reads as though the pass were doing almost nothing — backwards
  // from what a dry run is for. It misled a review of this pass once: 477
  // reported, of which 411 were about to be stamped and only 66 truly excluded.
  const remaining = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM team_plan_messages WHERE turn_id IS NULL`,
  );
  const unstampedNow = Number(remaining.rows[0]?.n ?? 0);
  report.messagesExcluded = dryRun ? unstampedNow - report.messagesStamped : unstampedNow;

  return report;
}

export async function main(): Promise<void> {
  const dryRun = process.env.BACKFILL_DRY_RUN === 'true';
  const parsed = Number.parseInt(process.env.BACKFILL_LIMIT ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;

  await initPool();
  let report: BackfillReport | null = null;
  try {
    report = await backfill(limit, dryRun);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'backfill: systemic failure — aborting');
  }
  if (report === null) {
    process.exit(1);
  }
  console.log(JSON.stringify({ backfillReport: { dryRun, limit, ...report } }, null, 2));
  process.exit(report.failures > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('backfill-team-plan-turns.js')) {
  void main();
}
