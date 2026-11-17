// Give the conversations that predate migration 547 the turn rows recall is
// keyed to, so a person's earlier Liftoff and Insights Manager conversations are
// searchable rather than invisible.
//
// 547 created the turns tables empty and deliberately backfilled nothing: from
// that point the chat services stamp every new turn, so only the history needs
// this pass. Without it a search reaches only conversations held after the
// migration, which is not what "search your earlier conversations" promises.
//
// THE BOUNDARY RULE, stated because it is an inference and inferences should be
// legible:
//
//   A turn starts at each plain `role='user'` row and contains that row plus
//   every row after it until the next plain user row.
//
// That is exact for an alternating transcript, which is nearly all of them. Two
// deliberate exclusions:
//
//   - A row carrying a `message_type` is narration, not speech (a status line, a
//     forwarded note, a presented file). It keeps turn_id NULL, which is what
//     NULL means on these columns, and it does not break a turn either: a status
//     line between a question and its answer leaves them in the same turn.
//   - Rows before a thread's FIRST user row belong to no turn. A greeting is not
//     an exchange, and inventing a turn to hold it would put words in a search
//     result that nobody said to anybody.
//
// ITS ONE KNOWN FAILURE MODE, so nobody has to rediscover it: if a person sent a
// second message while a reply was still running (these surfaces allow that —
// see claimUserMessageSignal), the reply lands after the newer message in
// created_at order and is grouped with it instead. Same thread, same person,
// seconds apart, so the cost is a slightly wrong pairing inside one excerpt, not
// a quote moved between conversations. The alternative — leaving the entire
// history unsearchable — is worse, and nothing in the data marks these cases, so
// no amount of care detects them here.
//
// IDEMPOTENT. Only messages with turn_id IS NULL are considered, so a rerun after
// a partial pass finishes the job and a rerun after a complete one does nothing.
// A thread is committed in one transaction: its turn rows and the stamps that
// point at them land together or not at all.
//
// Run as a Cloud Run Job against the platform-backend image:
//   node dist/scripts/backfill-platform-assistant-turns.js
// Env: BACKFILL_DRY_RUN=true  plan and count, write nothing (recommended first)
//      BACKFILL_LIMIT         max threads per surface (default 5000)

import { randomUUID } from 'crypto';
import { closePools, initDatabase, withAdminScope, withTenantScope } from '../infrastructure/database';
import { initSecrets } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';

/** The surfaces this pass covers. Team chat is excluded: agent_chat_turns has
 *  been stamped since migration 294 and has its own attribution backfill. The
 *  Chief AI Officer's threads live in another service's database and are covered
 *  by its own script. */
const SURFACES = [
  { label: 'liftoff', threads: 'liftoff_chat_threads', messages: 'liftoff_chat_messages', turns: 'liftoff_chat_turns' },
  { label: 'insights', threads: 'insights_chat_threads', messages: 'insights_chat_messages', turns: 'insights_chat_turns' },
] as const;

const DEFAULT_LIMIT = 5000;

interface SurfaceReport {
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
}

/** One thread's messages grouped into turns by the rule in the header. */
export function groupIntoTurns(rows: MessageRow[]): Array<{
  senderAccountId: string | null;
  createdAt: string;
  messageIds: string[];
}> {
  const turns: Array<{ senderAccountId: string | null; createdAt: string; messageIds: string[] }> = [];
  for (const row of rows) {
    const startsATurn = row.role === 'user' && row.message_type === null;
    if (startsATurn) {
      turns.push({ senderAccountId: row.sender_account_id, createdAt: row.created_at, messageIds: [row.id] });
      continue;
    }
    // Narration keeps NULL, whatever it sits between.
    if (row.message_type !== null) continue;
    // Before the first user row there is no turn to join.
    if (turns.length === 0) continue;
    turns[turns.length - 1].messageIds.push(row.id);
  }
  return turns;
}

async function backfillSurface(
  surface: (typeof SURFACES)[number],
  limit: number,
  dryRun: boolean,
): Promise<SurfaceReport> {
  const report: SurfaceReport = {
    threadsScanned: 0, threadsChanged: 0, turnsCreated: 0,
    messagesStamped: 0, messagesExcluded: 0, failures: 0,
  };

  // Candidate threads: those with at least one unstamped message. Enumerated
  // across tenants, which is what a one-pass history repair needs; every write
  // below runs under that thread's own tenant scope.
  const candidates = await withAdminScope(
    {
      caller: 'backfill-platform-assistant-turns',
      reason: `cross-tenant enumeration of ${surface.label} threads with unstamped messages; all writes run under withTenantScope per thread`,
    },
    (client) => client.query<{ id: string; tenant_id: string }>(
      `SELECT DISTINCT t.id, t.tenant_id
         FROM ${surface.threads} t
         JOIN ${surface.messages} m ON m.thread_id = t.id
        WHERE m.turn_id IS NULL
        ORDER BY t.id
        LIMIT $1`,
      [limit],
    ),
  );

  for (const thread of candidates.rows) {
    report.threadsScanned++;
    try {
      await withTenantScope(thread.tenant_id, async (client) => {
        // The WHOLE thread in reading order, not just the unstamped rows: a turn
        // already stamped must not be reopened, and a reply cannot be grouped
        // without seeing the user row it answers.
        const all = await client.query<MessageRow & { turn_id: string | null }>(
          `SELECT id, role, message_type, sender_account_id, created_at, turn_id
             FROM ${surface.messages}
            WHERE thread_id = $1
            ORDER BY created_at ASC, id ASC`,
          [thread.id],
        );

        const turns = groupIntoTurns(all.rows);
        // A turn any of whose rows is already stamped was done by an earlier run
        // or by the live path; leave it entirely alone.
        const pending = turns.filter((t) => t.messageIds.every((id) => {
          const row = all.rows.find((r) => r.id === id);
          return row && row.turn_id === null;
        }));

        if (pending.length === 0) return;

        if (dryRun) {
          report.turnsCreated += pending.length;
          report.messagesStamped += pending.reduce((n, t) => n + t.messageIds.length, 0);
          report.threadsChanged++;
          return;
        }

        await client.query('BEGIN');
        try {
          for (const turn of pending) {
            const turnId = randomUUID();
            await client.query(
              `INSERT INTO ${surface.turns} (id, tenant_id, thread_id, sender_account_id, created_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [turnId, thread.tenant_id, thread.id, turn.senderAccountId, turn.createdAt],
            );
            const stamped = await client.query(
              `UPDATE ${surface.messages} SET turn_id = $1
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
      });
    } catch (err) {
      report.failures++;
      log.error(
        { surface: surface.label, threadId: thread.id, error: (err as Error).message },
        'backfill: thread failed; continuing',
      );
    }
  }

  // What stays NULL on purpose: narration, and rows before a thread's first user
  // message. Counted so a reader can tell "left alone deliberately" from
  // "missed", which is indistinguishable in the table once the pass has run.
  //
  // SUBTRACTING THE STAMPED COUNT IS THE POINT. A plain count of turn_id IS NULL
  // is taken AFTER the writes in a real run, but BEFORE them in a dry run — so in
  // dry-run mode it counts every row the pass is about to stamp as "left
  // unstamped" and reads as though the pass were doing almost nothing. That is
  // exactly backwards from what a dry run is for, and it misled a review of this
  // pass once already (477 reported, of which 411 were about to be stamped and
  // only 66 genuinely excluded).
  const remaining = await withAdminScope(
    {
      caller: 'backfill-platform-assistant-turns',
      reason: `cross-tenant count of ${surface.label} rows carrying no turn`,
    },
    (client) => client.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${surface.messages} WHERE turn_id IS NULL`,
    ),
  );
  const unstampedNow = Number(remaining.rows[0]?.n ?? 0);
  report.messagesExcluded = dryRun ? unstampedNow - report.messagesStamped : unstampedNow;

  return report;
}

export async function main(): Promise<void> {
  const dryRun = process.env.BACKFILL_DRY_RUN === 'true';
  const parsed = Number.parseInt(process.env.BACKFILL_LIMIT ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;

  await initSecrets();
  await initDatabase();

  const out: Record<string, SurfaceReport> = {};
  let failed = false;
  try {
    for (const surface of SURFACES) {
      out[surface.label] = await backfillSurface(surface, limit, dryRun);
      if (out[surface.label].failures > 0) failed = true;
    }
  } catch (err) {
    log.error({ error: (err as Error).message }, 'backfill: systemic failure — aborting');
    failed = true;
  } finally {
    await closePools().catch(() => undefined);
  }

  console.log(JSON.stringify({ backfillReport: { dryRun, limit, surfaces: out } }, null, 2));
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  void main();
}
