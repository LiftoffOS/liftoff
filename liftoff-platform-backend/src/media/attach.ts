// The media attach helper — one seam so media is not implemented four times.
//
// A producer's whole job is to obtain bytes and call attachMedia(). This
// function stores the object once through the generated-files storage service
// (L1), builds the MediaRef every surface persists (L2), and writes it to the
// right message table through a small per-surface adapter. Adding a fifth
// surface later is one adapter, not another copy of storage, validation,
// screening and persistence.
//
// Reached two ways, same function underneath:
//   1. IN PROCESS by the platform agents (Liftoff, the Insights Manager),
//      which run inside platform-backend.
//   2. OVER HTTP by every out-of-process producer, through the existing
//      POST /api/generated-files with outputType 'media'. The tenant runtime
//      is the only one today.
//
// Validation, the MIME allow-list and the injection screening of
// producer-supplied `alt` and `filename` live HERE, once, so no caller can
// reach the message tables without them.

import { z } from 'zod';
import { stripControlChars } from '../common/chat-input-sanitize';
import type { MediaRef } from '../chat-attachments';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { screenPersistedContent } from '../injection-detection/gating';
import { log } from '../infrastructure/logging';
import {
  canonicalMediaMimeType,
  storeMediaObject,
  UnsupportedMediaTypeError,
} from '../generated-files/store';
import { readImageDimensions } from './image-dimensions';
import { MEDIA_MESSAGE_TYPE } from './message-type';
import * as agentChatRepo from '../agent-chat/chat-repository';
import * as liftoffRepo from '../liftoff/chat-repository';
import * as insightsRepo from '../insights/chat-repository';

// ── The contract ────────────────────────────────────────────────────────

// The contract itself lives in @liftoffos/chat-attachments, because the Chief
// AI Officer's messages table is in another repository and another database and
// a third hand-written copy of this shape is a third chance to disagree about a
// row all of them read. Re-exported here so every caller in this service keeps
// naming it through the module that owns the media path.
export type { MediaRef };

/** The message tables this helper knows how to write. `team_plan_messages`
 *  lives in the workforce service's own database and joins the day CAIO
 *  acquires a media producer; it has none today.
 *
 *  Declared as a schema, not just a type, because the HTTP door has to validate
 *  what an out-of-process producer names. One list, so a surface added to the
 *  adapter table below is reachable over HTTP without a second edit. */
export const mediaSurfaceSchema = z.enum(['agent_chat', 'liftoff', 'insights']);

export type MediaSurface = z.infer<typeof mediaSurfaceSchema>;

// The row type a media message carries, from its own leaf module so a caller
// that only needs the string does not import this one's machinery.
export { MEDIA_MESSAGE_TYPE } from './message-type';

export interface AttachMediaInput {
  surface: MediaSurface;
  tenantId: string;
  /** The conversation the media belongs to. Null stores the object and
   *  appends nothing — a producer that has bytes but no thread. */
  threadId: string | null;
  /** internal_agents.id of the producer, or null when the producer is one of
   *  the three platform assistants — they have no row in that table, and
   *  `agent_id` is a foreign key into it. A null here means the CONVERSATION
   *  owns the file; `threadId` and `surface` then say which one, and the store
   *  refuses the combination where all three are absent. Never a stand-in: a
   *  borrowed agent id would put an assistant's file in some agent's audit
   *  trail, which is the mistake migration 393 exists to prevent. */
  agentId: string | null;
  bytes: Buffer;
  mimeType: string;
  filename: string;
  alt?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** What the caller gets back: the stored contract, plus the two transport
 *  details the HTTP wrapper answers with. */
export interface AttachedMedia extends MediaRef {
  version: number;
  /** 1 hour from the write. Render paths re-mint through
   *  GET /api/generated-files/:id/download rather than trusting this. */
  downloadUrl: string;
}

// The refusal a disallowed media type gets is defined with the allow-list it
// comes from (../generated-files/store), and re-exported here so a caller that
// only knows the attach helper can still catch it by name.
export { UnsupportedMediaTypeError };

/** The producer's own description of its media was refused by injection
 *  screening. Only ever thrown for a tenant in enforce mode. */
export class MediaScreeningRefusedError extends Error {
  constructor(field: 'filename' | 'alt') {
    super(`Media ${field} refused by content screening`);
    this.name = 'MediaScreeningRefusedError';
  }
}

// ── Per-surface adapters ────────────────────────────────────────────────
//
// An adapter knows one thing: how to append a message row on its table and set
// `media` on it. Everything else — storage, naming, validation, screening — has
// already happened by the time one is called.

async function appendToAgentChat(
  input: AttachMediaInput,
  threadId: string,
  media: MediaRef,
): Promise<void> {
  await agentChatRepo.appendMediaMessage(input.tenantId, threadId, input.agentId, [media]);
}

async function appendToLiftoff(
  _input: AttachMediaInput,
  threadId: string,
  media: MediaRef,
): Promise<void> {
  await liftoffRepo.appendMessage({
    threadId,
    role: 'assistant',
    content: '',
    media: [media],
    messageType: MEDIA_MESSAGE_TYPE,
  });
}

async function appendToInsights(
  _input: AttachMediaInput,
  threadId: string,
  media: MediaRef,
): Promise<void> {
  await insightsRepo.appendMessage({
    threadId,
    role: 'assistant',
    content: '',
    media: [media],
    messageType: MEDIA_MESSAGE_TYPE,
  });
}

const ADAPTERS: Record<
  MediaSurface,
  (input: AttachMediaInput, threadId: string, media: MediaRef) => Promise<void>
> = {
  agent_chat: appendToAgentChat,
  liftoff: appendToLiftoff,
  insights: appendToInsights,
};

// ── Screening ───────────────────────────────────────────────────────────

/** The longest a producer's own name for its media may be. Matches the
 *  `baseName` bound on the upload route, which is where the stored object's
 *  name comes from. */
const MAX_FILENAME_CHARS = 255;

/** The longest description a producer may attach. Matches the route's `alt`
 *  bound; long enough for a real sentence about a picture, short enough that a
 *  thread's JSONB does not become a document store. */
const MAX_ALT_CHARS = 1000;

/** Collapse producer text to one printable line. A name that can insert a line
 *  break can forge structure in anything that later reads the transcript, and
 *  control characters render as nothing at all in the UI. */
function sanitizeProducerText(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/**
 * Screen one piece of producer-supplied text on its way into a message row.
 *
 * Both fields are attacker-influencable: a filename comes from whatever the
 * browser download tool was handed, and `alt` is written by a model that has
 * just read a page it did not choose. This is a WRITE, and a poisoned string
 * in a transcript keeps being read long after nobody is watching, which is
 * exactly the asymmetry screenPersistedContent exists for. It refuses only
 * when the tenant is in enforce mode.
 */
async function screenOrThrow(
  field: 'filename' | 'alt',
  value: string,
  ctx: { tenantId: string; agentId: string; threadId?: string },
): Promise<void> {
  if (!value) return;
  try {
    const screen = await screenPersistedContent('media', value, ctx);
    if (screen.block) throw new MediaScreeningRefusedError(field);
  } catch (err) {
    if (err instanceof MediaScreeningRefusedError) throw err;
    // Screening must never cost a delivered artifact on its own failure: the
    // same rule settle-turn applies. A detector that could not run knows
    // nothing, and refusing on that would make an outage look like an attack.
    log.warn(
      { tenantId: ctx.tenantId, field, error: (err as Error).message },
      'media: screening failed, attaching anyway',
    );
  }
}

// ── The helper ──────────────────────────────────────────────────────────

/**
 * Store bytes as media and reference them from a message.
 *
 * Order is load-bearing: validate, screen, THEN store. A refusal must not
 * leave an orphaned object in the bucket that nothing will ever point at.
 */
export async function attachMedia(input: AttachMediaInput): Promise<AttachedMedia> {
  // Canonical form, so a producer's casing or a multipart part's stray
  // `; charset=` never reaches the renderer's dispatch.
  const mimeType = canonicalMediaMimeType(input.mimeType);
  if (!mimeType) throw new UnsupportedMediaTypeError(input.mimeType);

  // Bounded HERE, not only at the HTTP door, so an in-process producer cannot
  // put an unbounded string into a JSONB column that every read of the thread
  // then carries. Truncated rather than refused: an over-long name or
  // description is a producer being careless, not hostile, and losing the
  // picture over it would be the wrong trade.
  const filename = sanitizeProducerText(input.filename).slice(0, MAX_FILENAME_CHARS) || 'media';
  const alt = input.alt
    ? sanitizeProducerText(input.alt).slice(0, MAX_ALT_CHARS) || undefined
    : undefined;

  const screenCtx = {
    tenantId: input.tenantId,
    // The screener wants a producer to attribute a refusal to. A
    // conversation-owned file has no agent, and the thread beside it is what
    // identifies the turn.
    agentId: input.agentId ?? '',
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  await screenOrThrow('filename', filename, screenCtx);
  if (alt) await screenOrThrow('alt', alt, screenCtx);

  // The base name is the producer's filename without its extension: the stored
  // object gets its extension from the MIME, which is the authority on how the
  // bytes are served, and PB versions per (agent, baseName).
  const dot = filename.lastIndexOf('.');
  const baseName = (dot > 0 ? filename.slice(0, dot) : filename).slice(0, 255);

  const stored = await storeMediaObject({
    tenantId: input.tenantId,
    agentId: input.agentId,
    baseName,
    outputType: 'media',
    bytes: input.bytes,
    originalFilename: filename,
    uploadedMimeType: mimeType,
    conversationId: input.threadId,
    // A producer's HTTP caller is answered with a downloadUrl, so this one is
    // read. (The in-process producers ignore it, but they share this helper
    // with the route and the route needs it.)
    signUrl: true,
    // Which table that thread id lives in. It used to be implied by a foreign
    // key to agent_chat_threads, which was only ever true for team chat — a
    // Liftoff or Insights producer writing through this same helper would have
    // hit a 23503 with its bytes already in the bucket. Migration 393 dropped
    // the key and this field carries the fact instead.
    surface: input.surface,
  });

  // Measure the image if the producer did not. Almost none of them can: a
  // screenshot tool has a PNG buffer and no decoder, and without dimensions the
  // renderer cannot reserve a box, so the whole transcript jumps when a
  // full-page screenshot finishes loading. Read from the header, never decoded,
  // and null when it cannot be read.
  const measured = input.width != null && input.height != null
    ? { width: input.width, height: input.height }
    : readImageDimensions(mimeType, input.bytes);

  const ref: MediaRef = {
    mediaId: stored.id,
    // The stored name, not the producer's: it carries the version suffix, so
    // two screenshots of the same page in one thread are told apart, and it is
    // what a download actually lands as.
    filename: stored.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    ...(measured ? { width: measured.width, height: measured.height } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(alt ? { alt } : {}),
  };

  if (input.threadId) {
    try {
      await ADAPTERS[input.surface](input, input.threadId, ref);
    } catch (appendErr) {
      // Deliberately fatal, unlike the document path's append. A `file_output`
      // card that fails to post still leaves a downloadable row somebody can be
      // pointed at; media that fails to post is invisible, and answering the
      // producer with a success would tell it the person is looking at
      // something nobody can see. The object stays in the bucket, named here so
      // it is traceable rather than anonymous.
      log.error(
        {
          error: (appendErr as Error).message,
          mediaId: ref.mediaId,
          surface: input.surface,
          threadId: input.threadId,
          tenantId: input.tenantId,
        },
        'media: stored the object but could not reference it from the conversation',
      );
      throw appendErr;
    }
  }

  // The same ledger a generated document lands in. Media is an artifact the
  // agent put in front of a person and left in a transcript, so leaving it out
  // would make /activity and any forensic timeline show every file the agent
  // produced except the ones it showed them. Best effort, exactly as the
  // document path treats it: an audit failure must not cost a delivered
  // artifact, and the row is already written by the time we get here.
  try {
    await agentAuditLogsService.insertAuditLog({
      tenantId: input.tenantId,
      internalAgentId: input.agentId ?? undefined,
      action: 'media.attached',
      inputArgs: {
        mediaId: ref.mediaId,
        filename: ref.filename,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        surface: input.surface,
        threadId: input.threadId,
      },
      outcome: 'success',
      triggeredBy: 'agent',
    });
  } catch (auditErr) {
    log.error(
      { error: (auditErr as Error).message, mediaId: ref.mediaId },
      'media: failed to insert audit log — continuing',
    );
  }

  return { ...ref, version: stored.version, downloadUrl: stored.signedUrl };
}
