// Chat-turn attribution export — TR side (plan v13 Change 5 step 1).
//
// TR's LOCAL audit_logs is the PRIMARY evidence source: its created_at is
// write-time truth (the outbox payload shipped to PB carries no original
// timestamp, so PB-side times are ingestion times and unusable), and its
// input_args retains the SANITIZED objective (= the user message text after
// sanitizeArgs).
//
// Exports rows for `action='agent_invocation_started'` with an
// account-UUID human trigger, mapping the RUNTIME agent id to the PLATFORM
// internal id via internal_agent_runtime_mapping. The portable file carries
// NO conversation-derived content: objectives leave as HMAC-SHA256 digests
// under a RUN-SCOPED key (Secret Manager version, destroyed by the PB
// matcher when the run completes); truncated objectives are flagged so the
// matcher can skip them without seeing text. The header carries the
// SANITIZER CONTRACT FINGERPRINT (redaction module bytes + SENSITIVE_KEYS +
// MAX_VALUE_LENGTH + truncation suffix + algorithm revision) — the PB
// matcher aborts with zero writes if its own fingerprint differs. Package
// version rides along as diagnostic metadata only.
//
// Env:
//   BACKFILL_EXPORT_BUCKET   control-project backfill bucket
//   BACKFILL_EXPORT_OBJECT   e.g. runs/2026-07-22-a1b2/export.jsonl
//   BACKFILL_HMAC_SECRET     full Secret Manager version resource name

import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Storage } from '@google-cloud/storage';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { MAX_VALUE_LENGTH, SENSITIVE_KEYS, TRUNCATION_SUFFIX } from '../audit/service';

// Must match PB src/scripts/chat-turn-backfill/sanitizer-contract.ts.
const SANITIZER_ALGORITHM_REVISION = 1;

export function computeSanitizerFingerprint(): string {
  const redactionModulePath = require.resolve('@liftoffos/proto-gen/dist/redaction');
  const moduleBytes = readFileSync(redactionModulePath);
  const contract = JSON.stringify({
    sensitiveKeys: SENSITIVE_KEYS,
    maxValueLength: MAX_VALUE_LENGTH,
    truncationSuffix: TRUNCATION_SUFFIX,
    algorithmRevision: SANITIZER_ALGORITHM_REVISION,
  });
  return createHash('sha256').update(moduleBytes).update('\n').update(contract).digest('hex');
}

/** Diagnostic metadata only — never the compatibility gate. The package's
 *  exports map rewrites `@liftoffos/proto-gen/package.json` to a nonexistent
 *  dist path (caught live in the dev E2E job), so read the file with fs
 *  relative to the already-resolved redaction module instead. */
function readProtoGenVersion(): string {
  try {
    const redactionModulePath = require.resolve('@liftoffos/proto-gen/dist/redaction');
    const pkgPath = join(dirname(redactionModulePath), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

const HUMAN_ACCOUNT_TRIGGER_RE = /^human:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuditRow {
  tenant_id: string;
  internal_agent_id: string;   // RUNTIME agents.id at this layer (TR naming)
  thread_id: string;
  invocation_id: string;
  created_at: Date;
  triggered_by: string;
  input_args: { objective?: unknown } | null;
}

export async function runExport(): Promise<void> {
  const bucketName = process.env.BACKFILL_EXPORT_BUCKET;
  const objectName = process.env.BACKFILL_EXPORT_OBJECT;
  const secretVersion = process.env.BACKFILL_HMAC_SECRET;
  if (!bucketName || !objectName || !secretVersion) {
    throw new Error('BACKFILL_EXPORT_BUCKET, BACKFILL_EXPORT_OBJECT, BACKFILL_HMAC_SECRET are required');
  }

  const secrets = new SecretManagerServiceClient();
  const [secretPayload] = await secrets.accessSecretVersion({ name: secretVersion });
  const keyB64 = secretPayload.payload?.data?.toString();
  if (!keyB64) throw new Error('run HMAC secret has no payload');
  const runKey = Buffer.from(keyB64, 'base64');

  const pool = getPoolForService('scheduled-execution');

  const mappings = await pool.query<{ agent_id: string; internal_agent_id: string; tenant_id: string }>(
    `SELECT agent_id, internal_agent_id, tenant_id FROM internal_agent_runtime_mapping`,
  );
  const runtimeToInternal = new Map(
    mappings.rows.map((m) => [`${m.tenant_id}:${m.agent_id}`, m.internal_agent_id]),
  );

  const rows = await pool.query<AuditRow>(
    `SELECT tenant_id, internal_agent_id, thread_id, invocation_id, created_at,
            triggered_by, input_args
     FROM audit_logs
     WHERE action = 'agent_invocation_started'
       AND thread_id IS NOT NULL
       AND invocation_id IS NOT NULL
       AND triggered_by LIKE 'human:%'
     ORDER BY created_at ASC`,
  );

  let exported = 0;
  let skippedNoMapping = 0;
  let skippedNoObjective = 0;
  // Unresolved Slack/Teams guests: the SQL filter already excludes
  // non-uuid triggers, but count them here (a second regex pass over what
  // the DB matched) so the PB matcher's report can carry the plan's
  // skipped-guest category — guests are only observable at export time.
  let skippedGuest = 0;

  const lines: string[] = [];

  for (const row of rows.rows) {
    if (!HUMAN_ACCOUNT_TRIGGER_RE.test(row.triggered_by)) {
      skippedGuest++;
      continue;
    }
    const senderAccountId = row.triggered_by.substring('human:'.length);
    const mapped = runtimeToInternal.get(`${row.tenant_id}:${row.internal_agent_id}`);
    if (!mapped) {
      skippedNoMapping++;
      continue;
    }
    // Stored input_args is ALREADY sanitized (insertAuditLog applies
    // sanitizeArgs before the local INSERT) — HMAC the stored value as-is.
    const objective = row.input_args?.objective;
    if (typeof objective !== 'string' || objective.length === 0) {
      skippedNoObjective++;
      continue;
    }
    lines.push(JSON.stringify({
      tenantId: row.tenant_id,
      internalAgentId: mapped,
      threadId: row.thread_id,
      invocationId: row.invocation_id,
      originalCreatedAt: row.created_at.toISOString(),
      senderAccountId,
      objectiveHmac: createHmac('sha256', runKey).update(objective, 'utf8').digest('hex'),
      truncated: objective.endsWith(TRUNCATION_SUFFIX),
    }));
    exported++;
  }

  // Header goes FIRST in the file but is built LAST — it carries counts
  // (guest skips) that only exist after the row pass.
  lines.unshift(JSON.stringify({
    kind: 'chat-turn-attribution-export',
    sanitizerFingerprint: computeSanitizerFingerprint(),
    // Diagnostic metadata only — never the compatibility gate.
    protoGenVersion: readProtoGenVersion(),
    exportedAt: new Date().toISOString(),
    guestRowsSkipped: skippedGuest,
  }));

  const storage = new Storage();
  await storage
    .bucket(bucketName)
    .file(objectName)
    .save(lines.join('\n') + '\n', { contentType: 'application/jsonl' });

  const report = { exported, skippedNoMapping, skippedNoObjective, skippedGuest };
  logger.info(report, 'chat-turn attribution export complete');
  console.log(JSON.stringify({ exportReport: report }, null, 2));
}

if (require.main === module) {
  runExport()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: (err as Error).message }, 'chat-turn attribution export failed');
      process.exit(1);
    });
}
