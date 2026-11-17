// Media the PERSON sends, as opposed to media an agent produces.
//
// The outbound helper next door (attach.ts) exists so a producer can hand over
// bytes and have them appear in a conversation. Inbound is the mirror image and
// differs in three ways that are each load-bearing:
//
//   1. There is no producing agent. The row's owner is an account, not an
//      internal_agents.id, and the audit trail says a person uploaded a file
//      rather than an agent publishing one.
//   2. Nothing is appended. The upload happens while the person is still
//      typing; the message that carries the reference is sent later, by the
//      chat surface, or never.
//   3. Because it may be never, an upload has to be CLAIMED. An unclaimed one
//      is swept, or the bucket fills with pictures nobody ever sent.
//
// What is deliberately shared with the outbound path: the storage service, the
// MIME allow-list, the dimension reader, the download route and its membership
// check. Inbound media differs in who uploaded it, not in what it is.

import { withAdminScope, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { screenPersistedContent } from '../injection-detection/gating';
import { stripControlChars } from '../common/chat-input-sanitize';
import type { MediaRef } from '../chat-attachments';
import {
  canonicalMediaMimeType,
  storeMediaObject,
  UnsupportedMediaTypeError,
} from '../generated-files/store';
import { MediaScreeningRefusedError } from './attach';
import { generatedFilesBucket } from '../generated-files/gcs-client';
import { readImageDimensions } from './image-dimensions';
import { bytesMatchDeclaredType } from './sniff-media-type';

/** The chat surfaces a person can attach media on. All four show the upload
 *  button, which is one more than the producer path knows about: the Chief AI
 *  Officer has no media producer, but people talk to it. */
export const INBOUND_SURFACES = ['agent_chat', 'liftoff', 'insights', 'team_plan'] as const;
export type InboundSurface = (typeof INBOUND_SURFACES)[number];

/** The bytes are not what the upload said they were. Distinct from
 *  UnsupportedMediaTypeError, which is about a type we do not store at all:
 *  this one is a type we DO store, claimed over bytes that are something
 *  else. */
// The refusals an upload can meet, re-exported so a route that only imports
// this module can still name them. Both come from the producer path, which is
// the point: one allow-list, one screening decision, one set of errors.
export { UnsupportedMediaTypeError, MediaScreeningRefusedError };

export class MediaContentMismatchError extends Error {
  constructor(declared: string) {
    super(`The uploaded file is not a valid ${declared}`);
    this.name = 'MediaContentMismatchError';
  }
}

export interface StoreInboundMediaInput {
  tenantId: string;
  /** accounts.id of the person uploading. */
  accountId: string;
  /** Which surface this will be sent on, when the composer knows it.
   *
   *  Null is a real answer, not a missing one. The dashboard home composer
   *  routes on an @mention parsed at SEND time, so at upload time the surface
   *  is genuinely undecided — and a row claiming the wrong table would be a
   *  worse record than one claiming nothing. `claimInboundMedia` stamps the
   *  fact when a message actually carries the upload. Nothing authorizes on
   *  this column; tenancy is `tenant_id` and RLS, as everywhere else. */
  surface: InboundSurface | null;
  /** The thread they are typing in, when there is one. A composer on a brand
   *  new conversation has no thread id yet, and the upload still has to work —
   *  the claim step fills it in once the message is sent. */
  threadId: string | null;
  bytes: Buffer;
  /** What the browser said the file is. Checked against the bytes. */
  mimeType: string;
  /** The person's own file name. */
  filename: string;
}

/** How long an upload may sit unclaimed before it is swept. */
export const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Collapse a person's file name to one printable line. Same treatment the
 *  producer path gives its own, and for the same reason: a name that can carry
 *  a newline can forge structure in anything that reads the transcript later. */
function sanitizeFilename(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/**
 * Store one uploaded file and return the reference a message will carry.
 *
 * Appends nothing. The order is the same as the producer path's and for the
 * same reason: validate, screen, THEN store, so a refusal never leaves an
 * object in the bucket that nothing will point at.
 */
export async function storeInboundMedia(input: StoreInboundMediaInput): Promise<MediaRef> {
  const mimeType = canonicalMediaMimeType(input.mimeType);
  if (!mimeType) throw new UnsupportedMediaTypeError(input.mimeType);

  // The allow-list above is checked against a label the BROWSER chose. This is
  // the same check against the bytes, and it is the one that matters: without
  // it, `image/png` is a claim anybody can make about any file, and the
  // allow-list that keeps executable markup out of a bucket we serve back into
  // the user's origin is decoration.
  if (!bytesMatchDeclaredType(input.bytes, mimeType)) {
    throw new MediaContentMismatchError(mimeType);
  }

  const filename = sanitizeFilename(input.filename).slice(0, 255) || 'upload';

  // A file name is chat input: it is echoed to the model in the attachment
  // notice, stored in a transcript, and read back long after anybody is
  // watching. Screened on the same path the producer path screens its own,
  // which refuses only for a tenant in enforce mode.
  try {
    const screen = await screenPersistedContent('media', filename, {
      tenantId: input.tenantId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    if (screen.block) {
      throw new MediaScreeningRefusedError('filename');
    }
  } catch (err) {
    if (err instanceof MediaScreeningRefusedError) throw err;
    // A detector that could not run knows nothing, and refusing on that would
    // make an outage look like an attack.
    log.warn(
      { tenantId: input.tenantId, error: (err as Error).message },
      'inbound media: screening failed, storing anyway',
    );
  }

  const dot = filename.lastIndexOf('.');
  const baseName = (dot > 0 ? filename.slice(0, dot) : filename).slice(0, 255);

  const stored = await storeMediaObject({
    tenantId: input.tenantId,
    agentId: null,
    uploadedByAccountId: input.accountId,
    surface: input.surface,
    baseName,
    outputType: 'media',
    bytes: input.bytes,
    originalFilename: filename,
    uploadedMimeType: mimeType,
    conversationId: input.threadId,
    // No URL. This path answers with a REFERENCE; the browser mints its own
    // short-lived URL through the download route when it renders the picture.
    // Signing here would be an IAM round trip on every upload for a string
    // nobody reads.
    signUrl: false,
  });

  const measured = readImageDimensions(mimeType, input.bytes);

  return {
    mediaId: stored.id,
    filename: stored.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    ...(measured ? { width: measured.width, height: measured.height } : {}),
  };
}

/**
 * Mark uploads as carried by a sent message, so retention leaves them alone.
 *
 * Called by every surface at the moment it persists the user's message, which
 * is the moment the upload stops being provisional. Idempotent: a re-sent turn
 * or a retried write re-stamps the same rows.
 *
 * Deliberately tolerant of ids it does not find. A client can name a media id
 * that belongs to another tenant or does not exist, and the right answer is to
 * claim nothing rather than to fail the person's message — the reference will
 * simply render as missing media, which is what it is. RLS is what makes that
 * safe: the UPDATE runs in tenant scope, so a cross-tenant id matches zero rows.
 */
export async function claimInboundMedia(
  tenantId: string,
  mediaIds: readonly string[],
  threadId: string,
  surface: InboundSurface,
): Promise<number> {
  if (mediaIds.length === 0) return 0;
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE generated_files
          SET claimed_at      = COALESCE(claimed_at, now()),
              conversation_id = $2,
              surface         = $3
        WHERE id = ANY($1::uuid[])
          AND uploaded_by_account_id IS NOT NULL`,
      [[...mediaIds], threadId, surface],
    ),
  );
  return result.rowCount ?? 0;
}

/**
 * Delete uploads nobody ever sent.
 *
 * Producer media is owned by a message written in the same call, so it is never
 * orphaned. An upload is: it exists from the moment the person picks the file,
 * and the message that would own it is still being typed. Most are claimed
 * within seconds; the ones that are not are a closed tab, and they would
 * otherwise sit in the bucket forever, indistinguishable from real artifacts.
 *
 * The object goes before the row. If the delete crashes between the two, the
 * row is still unclaimed and the next sweep retries — GCS delete is idempotent
 * for our purposes (a missing object is a completed delete). The other order
 * would leave an object with no row, which nothing can ever find again.
 *
 * Runs under admin scope because it is cross-tenant by nature: it is one
 * housekeeping pass over the estate, not a tenant's own request.
 */
export async function sweepAbandonedUploads(
  options: { olderThanMs?: number; limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const olderThanMs = options.olderThanMs ?? UPLOAD_RETENTION_MS;
  const limit = options.limit ?? 500;
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await withAdminScope(
    {
      caller: 'media.sweepAbandonedUploads',
      reason: 'retention sweep of unclaimed inbound uploads across tenants',
    },
    (client) =>
      client.query(
      `SELECT id, tenant_id, gcs_path
         FROM generated_files
        WHERE claimed_at IS NULL
          AND uploaded_by_account_id IS NOT NULL
          AND created_at < $1
        ORDER BY created_at
        LIMIT $2`,
        [cutoff, limit],
      ),
  );

  let deleted = 0;
  let failed = 0;
  for (const row of stale.rows as Array<{ id: string; tenant_id: string; gcs_path: string | null }>) {
    try {
      if (row.gcs_path) {
        await generatedFilesBucket().file(row.gcs_path).delete({ ignoreNotFound: true });
      }
      await withAdminScope(
        {
          caller: 'media.sweepAbandonedUploads',
          reason: 'delete one unclaimed inbound upload',
        },
        (client) => client.query(`DELETE FROM generated_files WHERE id = $1`, [row.id]),
      );
      deleted += 1;
    } catch (err) {
      // One unreachable object must not stop the pass: the rest of the batch is
      // still deletable, and this row is picked up again next time.
      failed += 1;
      log.warn(
        { error: (err as Error).message, mediaId: row.id, tenantId: row.tenant_id },
        'inbound media: could not sweep abandoned upload',
      );
    }
  }

  if (deleted > 0 || failed > 0) {
    log.info({ deleted, failed }, 'inbound media: swept abandoned uploads');
  }
  return { deleted, failed };
}
