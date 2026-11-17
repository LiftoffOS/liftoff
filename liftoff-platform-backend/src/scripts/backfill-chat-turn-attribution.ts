// Chat-turn attribution backfill — PB matcher job (plan v13 Change 5).
//
// Consumes the TR exporter's portable file (GCS, JSONL: header line then
// rows), verifies the SANITIZER CONTRACT FINGERPRINT (mismatch → abort with
// ZERO writes), loads the run-scoped HMAC key from Secret Manager, matches
// export rows to unattributed PB chat messages via HMAC-of-sanitized-content
// equality (pure logic in ./chat-turn-backfill/matcher — provable-only, all
// ambiguity skipped), and synthesizes agent_chat_turns rows with
// id = invocation_id (deterministic; re-runs no-op on PK conflict).
//
// Each synthesized turn = ONE transaction: turn INSERT + both message
// UPDATEs with affected-row checks; anything unexpected rolls back that turn
// and is counted. On success AND failure the finally-block deletes the
// export object and destroys the run secret version (7-day bucket lifecycle
// + secret TTL are the abandoned-run backstop).
//
// Env:
//   BACKFILL_EXPORT_BUCKET   e.g. YOUR_GCP_PROJECT
//   BACKFILL_EXPORT_OBJECT   e.g. runs/2026-07-22-a1b2/export.jsonl
//   BACKFILL_HMAC_SECRET     full Secret Manager version resource name
//   BACKFILL_DRY_RUN         'true' → plan + report only, no writes/cleanup

import { Storage } from '@google-cloud/storage';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { initSecrets } from '../infrastructure/secrets';
import { closePools, initDatabase, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  computeSanitizerFingerprint,
  hmacSanitized,
  sanitizeContent,
} from './chat-turn-backfill/sanitizer-contract';
import {
  emptySkips,
  mergeSkips,
  planThreadAssignments,
  type Assignment,
  type ExportRow,
  type SkipCounts,
  type ThreadMessage,
} from './chat-turn-backfill/matcher';

interface ExportHeader {
  kind: 'chat-turn-attribution-export';
  sanitizerFingerprint: string;
  protoGenVersion: string; // diagnostic metadata only
  exportedAt: string;
  /** Unresolved Slack/Teams guests skipped at export time — guests never
   *  reach the matcher, so the plan's skipped-guest report category is
   *  sourced from the exporter via this header field. */
  guestRowsSkipped?: number;
}

interface ChannelReport {
  attributed: number;
  skips: SkipCounts;
  rollbacks: number;
  alreadyAttributed: number;
}

async function applyAssignment(
  assignment: Assignment,
): Promise<'attributed' | 'already_attributed' | 'rollback'> {
  const { row } = assignment;
  return withTenantScope(row.tenantId, async (client) => {
    // withTenantScope wraps a single transaction; any throw rolls back.
    const turnInsert = await client.query(
      `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.invocationId,
        row.tenantId,
        row.threadId,
        row.internalAgentId,
        row.senderAccountId,
        row.originalCreatedAt,
      ],
    );
    if (turnInsert.rowCount === 0) {
      // Deterministic id already present — a prior run attributed this turn.
      return 'already_attributed';
    }
    const userUpdate = await client.query(
      `UPDATE agent_chat_messages SET turn_id = $1
       WHERE id = $2 AND tenant_id = $3 AND turn_id IS NULL`,
      [row.invocationId, assignment.userMessageId, row.tenantId],
    );
    const assistantUpdate = await client.query(
      `UPDATE agent_chat_messages SET turn_id = $1
       WHERE id = $2 AND tenant_id = $3 AND turn_id IS NULL`,
      [row.invocationId, assignment.assistantMessageId, row.tenantId],
    );
    if (userUpdate.rowCount !== 1 || assistantUpdate.rowCount !== 1) {
      throw new Error(
        `affected-row check failed (user=${userUpdate.rowCount}, assistant=${assistantUpdate.rowCount})`,
      );
    }
    return 'attributed';
  }).catch((err: Error) => {
    log.warn(
      { invocationId: row.invocationId, threadId: row.threadId, error: err.message },
      'backfill: turn rolled back',
    );
    return 'rollback' as const;
  });
}

export async function runBackfill(): Promise<void> {
  const bucketName = process.env.BACKFILL_EXPORT_BUCKET;
  const objectName = process.env.BACKFILL_EXPORT_OBJECT;
  const secretVersion = process.env.BACKFILL_HMAC_SECRET;
  const dryRun = process.env.BACKFILL_DRY_RUN === 'true';
  if (!bucketName || !objectName || !secretVersion) {
    throw new Error('BACKFILL_EXPORT_BUCKET, BACKFILL_EXPORT_OBJECT, BACKFILL_HMAC_SECRET are required');
  }

  const storage = new Storage();
  const secrets = new SecretManagerServiceClient();
  const object = storage.bucket(bucketName).file(objectName);

  try {
    const [raw] = await object.download();
    const lines = raw.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error('export file is empty');

    const header = JSON.parse(lines[0]) as ExportHeader;
    if (header.kind !== 'chat-turn-attribution-export') {
      throw new Error(`unexpected export kind: ${header.kind}`);
    }

    // SANITIZER CONTRACT GATE — mismatch aborts with zero writes; never
    // silently-reduced coverage.
    const localFingerprint = computeSanitizerFingerprint();
    if (header.sanitizerFingerprint !== localFingerprint) {
      log.error(
        {
          exportFingerprint: header.sanitizerFingerprint,
          localFingerprint,
          exportProtoGenVersion: header.protoGenVersion,
        },
        'backfill: sanitizer contract fingerprint mismatch — ABORTING with zero writes',
      );
      throw new Error('sanitizer contract fingerprint mismatch');
    }

    const [secretPayload] = await secrets.accessSecretVersion({ name: secretVersion });
    const keyB64 = secretPayload.payload?.data?.toString();
    if (!keyB64) throw new Error('run HMAC secret has no payload');
    const runKey = Buffer.from(keyB64, 'base64');

    const rows = lines.slice(1).map((l) => JSON.parse(l) as ExportRow);
    log.info({ rows: rows.length, dryRun }, 'backfill: export loaded');

    // Group rows by (tenant, thread).
    const byThread = new Map<string, ExportRow[]>();
    for (const row of rows) {
      const key = `${row.tenantId}:${row.threadId}`;
      byThread.set(key, [...(byThread.get(key) ?? []), row]);
    }

    const perChannel = new Map<string, ChannelReport>();
    const channelReport = (channel: string): ChannelReport => {
      const existing = perChannel.get(channel);
      if (existing) return existing;
      const fresh: ChannelReport = {
        attributed: 0,
        skips: emptySkips(),
        rollbacks: 0,
        alreadyAttributed: 0,
      };
      perChannel.set(channel, fresh);
      return fresh;
    };

    for (const [key, threadRows] of byThread) {
      const [tenantId, threadId] = key.split(':');

      const loaded = await withTenantScope(tenantId, async (client) => {
        const thread = await client.query(
          `SELECT channel, deleted_at FROM agent_chat_threads WHERE id = $1 AND tenant_id = $2`,
          [threadId, tenantId],
        );
        const messages = await client.query(
          `SELECT id, role, agent_id, content, created_at, turn_id
           FROM agent_chat_messages
           WHERE thread_id = $1 AND tenant_id = $2
           ORDER BY created_at ASC`,
          [threadId, tenantId],
        );
        return { thread: thread.rows[0], messages: messages.rows };
      });

      const channel = (loaded.thread?.channel as string) ?? 'unknown';
      const report = channelReport(channel);
      if (!loaded.thread) {
        report.skips.noUserMatch += threadRows.length;
        continue;
      }

      const messages: ThreadMessage[] = (loaded.messages as Array<{
        id: string;
        role: 'user' | 'assistant' | 'tool';
        agent_id: string | null;
        content: string;
        created_at: Date;
        turn_id: string | null;
      }>).map((m) => ({
        id: m.id,
        role: m.role,
        agentId: m.agent_id,
        createdAt: m.created_at.toISOString(),
        turnId: m.turn_id,
        contentHmac:
          m.role === 'user' && m.turn_id === null
            ? hmacSanitized(runKey, sanitizeContent(m.content))
            : undefined,
      }));

      const plan = planThreadAssignments(threadRows, messages);
      report.skips = mergeSkips(report.skips, plan.skips);

      for (const assignment of plan.assignments) {
        if (dryRun) {
          report.attributed++;
          continue;
        }
        const outcome = await applyAssignment(assignment);
        if (outcome === 'attributed') report.attributed++;
        else if (outcome === 'already_attributed') report.alreadyAttributed++;
        else report.rollbacks++;
      }
    }

    const reportObject = Object.fromEntries(perChannel);
    const skippedGuest = header.guestRowsSkipped ?? 0;
    log.info({ report: reportObject, skippedGuest, dryRun }, 'backfill: complete');
    // Also print to stdout for the operator reading job logs.
    console.log(JSON.stringify({ backfillReport: reportObject, skippedGuest, dryRun }, null, 2));
  } finally {
    if (!dryRun) {
      // Success AND failure: remove the artifact and destroy the run key.
      try {
        await object.delete({ ignoreNotFound: true });
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'backfill: export object delete failed');
      }
      try {
        await secrets.destroySecretVersion({ name: secretVersion });
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'backfill: secret version destroy failed');
      }
    }
  }
}

if (require.main === module) {
  // Standard PB one-off-script bootstrap (see backfill-pinned-knowledge):
  // secrets first (DB password may come from Secret Manager), then pools.
  (async () => {
    await initSecrets();
    await initDatabase();
    await runBackfill();
  })()
    .then(() => closePools())
    .then(() => process.exit(0))
    .catch(async (err) => {
      log.error({ error: (err as Error).message }, 'backfill: failed');
      await closePools().catch(() => undefined);
      process.exit(1);
    });
}
