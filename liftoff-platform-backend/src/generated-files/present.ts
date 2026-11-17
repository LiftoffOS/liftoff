// Publishing a file that already exists.
//
// Writing a file and showing it to somebody are different decisions, and until
// this module they were the same request. Every writer of a card created the
// file in the same breath (`appendFileCard` has two call sites, both directly
// after an insert), so bytes that arrived without a conversation — an
// autonomous run's output, anything a custom API answered with — could never
// afterwards be put in front of a person. Meanwhile the runtime told models a
// card could be "forwarded through any other tool that takes a
// generatedFileId". No such tool existed.
//
// The rule, stated by the platform whose two-plane design the connector work
// follows: writing a file never makes it visible; visibility is always a
// separate, explicit act. Their file reference carries a path and nothing
// else, and which conversation shows it is decided by where the reply goes.
// So nothing here takes a conversation from the file, and no execute contract
// gains a thread field. The caller who knows the conversation names it.
//
// Shaped after `media/attach.ts` deliberately: one function, one adapter per
// surface, and the parts that must not vary per surface — the lookup, the
// tenancy check, clearing the staged lifetime, the audit row — done once
// before any adapter is reached.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { generatedFilesBucket } from './gcs-client';
import { FILE_OUTPUT_MESSAGE_TYPE, type FileCard } from './file-card';
import * as agentChatRepo from '../agent-chat/chat-repository';
import * as liftoffRepo from '../liftoff/chat-repository';
import * as insightsRepo from '../insights/chat-repository';
import { workforceServiceBaseUrl } from '../workforce-plans/team-plan-thread-client';
import { buildOidcAuthHeader } from '@liftoffos/service-client';

/** Where a file can be shown. The four conversation surfaces, by the names the
 *  store already uses for them. */
export type PresentSurface = 'agent_chat' | 'liftoff' | 'insights' | 'team_plan';

export interface PresentFileInput {
  tenantId: string;
  /** The stored file to show. */
  fileId: string;
  surface: PresentSurface;
  /** The conversation to show it in. The caller's, never the file's. */
  conversationId: string;
  /** `internal_agents.id` of whoever is presenting. Null for a platform
   *  assistant, which has no row in that table. */
  agentId: string | null;
  /** The chat turn this happened in, when the caller knows it. */
  turnId?: string | null;
}

export class PresentFileError extends Error {
  readonly reason: 'not_found' | 'no_surface' | 'unsupported_surface';
  constructor(reason: PresentFileError['reason'], message: string) {
    super(message);
    this.name = 'PresentFileError';
    this.reason = reason;
  }
}

/** What the caller gets back: enough to say what happened, never the bytes. */
export interface PresentedFile {
  filename: string;
  outputType: string;
  version: number;
}

/**
 * Show a stored file in a conversation.
 *
 * Reads the row, stops being staged, appends one card. The file is not copied,
 * re-stored or re-typed: a presented file is the same row it always was, which
 * is what makes presenting it twice harmless and what keeps one file from
 * becoming three under three surfaces.
 */
export async function presentFile(input: PresentFileInput): Promise<PresentedFile> {
  const { tenantId, fileId, surface, conversationId } = input;

  // RLS-scoped, so a file belonging to another workspace reads as absent
  // rather than as a refusal that confirms it exists.
  const found = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT filename, base_name, version, output_type, gcs_path, web_view_url,
              mime_type, discard_after
       FROM generated_files WHERE id = $1`,
      [fileId],
    ),
  );
  if (found.rows.length === 0) {
    throw new PresentFileError('not_found', `no file in this workspace has the id ${fileId}`);
  }
  const row = found.rows[0] as {
    filename: string;
    base_name: string;
    version: number;
    output_type: string;
    gcs_path: string | null;
    web_view_url: string | null;
    mime_type: string | null;
    discard_after: Date | null;
  };

  const card: FileCard = {
    generatedFileId: fileId,
    filename: row.filename,
    outputType: row.output_type,
    version: row.version,
    // A file that lives in a connected service has no download of ours, and
    // the card reads null as "offer to open it there" rather than as a broken
    // save button. Everything else gets a fresh URL; it is a convenience, and
    // the card re-mints its own when a person clicks.
    downloadUrl: row.gcs_path ? await signedUrlFor(row.gcs_path) : null,
    ...(row.web_view_url ? { webViewUrl: row.web_view_url } : {}),
  };

  await ADAPTERS[surface](input, card);

  // Publishing is what makes a file permanent. Done after the card, so a file
  // whose card could not be written keeps its lifetime and is swept rather
  // than kept forever with nothing pointing at it.
  if (row.discard_after !== null) {
    await withTenantScope(tenantId, (client) =>
      client.query('UPDATE generated_files SET discard_after = NULL WHERE id = $1', [fileId]),
    );
  }

  // The same audit action the two registration routes write, because from the
  // outside this is the same event: a file reached a person.
  try {
    await agentAuditLogsService.insertAuditLog({
      tenantId,
      // A platform assistant has no row in internal_agents, and the column
      // is nullable for exactly that reason (migration 393).
      internalAgentId: input.agentId ?? undefined,
      action: 'document.generated',
      inputArgs: {
        filename: row.filename,
        outputType: row.output_type,
        version: row.version,
        generatedFileId: fileId,
        downloadUrl: card.downloadUrl,
        ...(card.webViewUrl ? { webViewUrl: card.webViewUrl } : {}),
        // What tells this apart from the row a producer writes: the bytes were
        // already here and somebody chose to show them.
        presented: true,
      },
      outcome: 'success',
      triggeredBy: 'agent',
    });
  } catch (auditErr) {
    // A missing audit row must not cost the person the file they asked for.
    log.error(
      { error: (auditErr as Error).message, generatedFileId: fileId },
      'generated-files: present — audit write failed, continuing',
    );
  }

  log.info(
    { tenantId, generatedFileId: fileId, surface, conversationId },
    'generated_file_presented',
  );
  return { filename: row.filename, outputType: row.output_type, version: row.version };
}

async function signedUrlFor(gcsPath: string): Promise<string | null> {
  try {
    const [url] = await generatedFilesBucket()
      .file(gcsPath)
      .getSignedUrl({ action: 'read', expires: Date.now() + 3_600_000 });
    return url;
  } catch (err) {
    // The card re-mints its own URL through the download route, so a signing
    // failure costs a convenience and not the file. Null rather than an empty
    // string: the card reads those differently.
    log.warn({ error: (err as Error).message, gcsPath }, 'generated-files: present — signing failed');
    return null;
  }
}

// ── Per-surface adapters ────────────────────────────────────────────────
//
// An adapter knows one thing: how to append a card row on its own table.
// Everything else has already happened by the time one is called.

async function presentInAgentChat(input: PresentFileInput, card: FileCard): Promise<void> {
  // Team chat's card has always ridden `attachments`, where that column means
  // what the assistant produced. Unchanged here on purpose: every reader of
  // that shape is already written.
  await agentChatRepo.appendMessage(
    input.tenantId,
    input.conversationId,
    'assistant',
    '',
    input.agentId ?? undefined,
    null,
    0,
    0,
    FILE_OUTPUT_MESSAGE_TYPE,
    [card as unknown as Record<string, unknown>],
    undefined,
    // Never `turn_id`: the reply owns that, and the uniqueness constraint on an
    // assistant row would reject a second holder. The turn rides its own column.
    null,
    null,
    input.turnId ?? null,
  );
}

async function presentInLiftoff(input: PresentFileInput, card: FileCard): Promise<void> {
  await liftoffRepo.appendMessage({
    threadId: input.conversationId,
    role: 'assistant',
    content: '',
    files: [card],
    messageType: FILE_OUTPUT_MESSAGE_TYPE,
  });
}

async function presentInInsights(input: PresentFileInput, card: FileCard): Promise<void> {
  await insightsRepo.appendMessage({
    threadId: input.conversationId,
    role: 'assistant',
    content: '',
    files: [card],
    messageType: FILE_OUTPUT_MESSAGE_TYPE,
  });
}

async function presentInTeamPlan(input: PresentFileInput, card: FileCard): Promise<void> {
  // The Chief AI Officer's messages live in the workforce service's own
  // database, so this surface is a call rather than an insert. Same shape on
  // the wire as the row the other three write, and the same two gates every
  // other call to that service passes: the shared service token AND OIDC.
  const base = workforceServiceBaseUrl();
  const token = process.env['WORKFORCE_SERVICE_TOKEN'];
  if (!base || !token) {
    throw new PresentFileError(
      'no_surface',
      'this environment cannot reach the Chief AI Officer conversation store',
    );
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Service-Auth': token,
  };
  try {
    const oidc = await buildOidcAuthHeader(base);
    for (const [k, v] of Object.entries(oidc)) headers[k] = v;
  } catch (err) {
    // Absent locally and in tests; the service token still gates the call.
    log.debug({ err: (err as Error).message }, 'generated-files: present — OIDC build failed');
  }
  const response = await fetch(`${base}/internal/team-plan/file-card`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tenantId: input.tenantId,
      threadId: input.conversationId,
      file: card,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new PresentFileError(
      'no_surface',
      `the Chief AI Officer conversation store refused the card (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
}

const ADAPTERS: Record<
  PresentSurface,
  (input: PresentFileInput, card: FileCard) => Promise<void>
> = {
  agent_chat: presentInAgentChat,
  liftoff: presentInLiftoff,
  insights: presentInInsights,
  team_plan: presentInTeamPlan,
};
