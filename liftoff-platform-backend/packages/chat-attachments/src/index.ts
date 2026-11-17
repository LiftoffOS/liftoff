// What a chat message carries besides its text, written once for every surface.
//
// Two things qualify and they are opposites, which is why they share a module
// rather than each getting one: an ATTACHMENT is what the person handed the
// team, and a MEDIA REF is what the team produced for the person to look at.
// Both are non-text payloads on a message row, both are stored as metadata with
// the bytes held elsewhere, and both have to mean the same thing on every
// surface or the renderer that draws them cannot be shared.
//
// Liftoff had all of this first, named for itself: LiftoffAttachment,
// LiftoffUploadAttachment, and a zod schema and prompt wrapper that lived in
// its stream router. The Insights Manager and the Chief AI Officer each show
// the person a file-upload button and each drop what they attach, so they need
// exactly these pieces. The Chief AI Officer runs in a different repository
// with a different framework, so the contract can only reach it as a published
// package — which is why this is a package and not a module.
//
// What lives here is everything both surfaces must agree on:
//   - the shape of an attachment on the wire, and the caps it must respect
//   - the zod schema that enforces them
//   - the projection that decides what is kept once the turn is over
//   - the <attachment name="..."> wrapper the model actually reads
//
// What does NOT live here is anything about a particular surface: how it
// sanitizes, which table it writes, how it budgets its prompt.

import { z } from 'zod';
// The control-character strip every chat surface already uses on typed text.
// Imported rather than restated: an attachment name is chat input, and two
// answers to "what is a control character" is exactly how the two surfaces
// would start disagreeing about the same file.
import { stripControlChars } from '@liftoffos/service-runtime';

// ── Media ───────────────────────────────────────────────────────────────

/**
 * One reference to one piece of media, stored identically on every surface.
 *
 * `mimeType` is the discriminator and the only thing the renderer dispatches
 * on. There is deliberately no `kind: 'image' | 'video'` field: it would
 * duplicate what the MIME already says and would eventually disagree with it.
 *
 * The bytes are never here. They live in object storage behind the platform's
 * generated-files service, and the URL is minted fresh at render time — a URL
 * baked in at write time is dead an hour later, which is fine for a card you
 * click and useless for an image that loads on sight.
 *
 * It lives in this package rather than in platform-backend because the Chief AI
 * Officer's messages table is in another repository and another database. A
 * third hand-written copy of this shape is a third chance to disagree about a
 * row all three of them read.
 */
export interface MediaRef {
  /** The stored artifact's id — what the download route is asked for. */
  mediaId: string;
  /** Authoritative; drives rendering. */
  mimeType: string;
  filename: string;
  sizeBytes?: number;
  /** Images and video, when known: lets the renderer reserve layout space so
   *  the thread does not jump when the media loads. */
  width?: number;
  height?: number;
  /** Video and audio, when known. */
  durationMs?: number;
  /** Producer-supplied description, used as alt text. */
  alt?: string;
}

/**
 * The same shape as a zod schema, for the boundaries that have to VALIDATE one
 * rather than just carry it.
 *
 * Inbound media put a MediaRef on the wire for the first time. Until then every
 * ref in this estate was minted server-side by the code that stored the bytes,
 * so nothing ever parsed one; a person's browser now sends one back on the next
 * chat request, and a client-supplied `mediaId` that is not a uuid must be
 * refused at the door rather than reaching a query.
 *
 * The bounds mirror what the store can actually produce: `mimeType` is checked
 * against the real allow-list where the bytes are read, and this only keeps a
 * pathological string out of a JSONB column.
 */
export const mediaRefSchema = z.object({
  mediaId: z.string().uuid(),
  mimeType: z.string().min(1).max(128),
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  alt: z.string().max(1000).optional(),
});

// ── Contributors ────────────────────────────────────────────────────────

/**
 * A colleague, other than the assistant whose surface a reply is on, who had
 * a hand in that reply. One shape on every chat surface: on Liftoff a
 * hand-over puts the colleague who wrote the whole reply here (the
 * one-element case, derived from its `author` / `author_label` columns); on
 * team chat each teammate the team delegated part of the work to is listed,
 * in the order they were first brought in; the Insights Manager and the
 * Chief AI Officer carry the same column so a colleague of theirs is
 * attributed the same way the day one exists.
 *
 * `label` is the display name as the person saw it, stored beside the reply
 * rather than resolved on read, so renaming or deleting a team never relabels
 * an answer somebody has already had — the same rule `author_label` follows.
 *
 * It lives here for the reason MediaRef does: the Chief AI Officer's messages
 * table is in another repository and another database, and a third
 * hand-written copy of a row all three read is a third chance to disagree.
 */
export interface Contributor {
  /** `'caio'`, `'insights'`, or an `internal_agents.id`. */
  id: string;
  label: string;
}

/** The same shape as a zod schema, for the boundaries that VALIDATE one — the
 *  settle callback a runtime posts a turn's contributors through. */
export const contributorSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

export const contributorsSchema = z.array(contributorSchema);

// ── Caps ────────────────────────────────────────────────────────────────

/** How many attachments one message may carry, and how much text each may
 *  hold. Chosen against the 50KB body limit on the stream routes: 8 x 4000
 *  characters plus a 4000-character message is ~36KB of payload, so a request
 *  at the cap is still accepted rather than rejected by the body parser for a
 *  reason the person cannot see. 4000 is the message cap this product already
 *  uses for typed text. */
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_CONTENT_CHARS = 4000;
export const MAX_ATTACHMENT_NAME_CHARS = 200;

/**
 * How many pieces of media one message may carry.
 *
 * Deliberately its own cap rather than a share of MAX_ATTACHMENTS. Media does
 * not spend the 4000-character text budget those eight were sized against — it
 * rides out of band and puts only a reference on the request — so folding the
 * two together would either starve text of slots or let media inherit a bound
 * that says nothing about what media actually costs. What media costs is
 * tokens, and that is capped separately below.
 */
export const MAX_MEDIA_ATTACHMENTS = 4;

/**
 * The largest single file the ingest route will store.
 *
 * Set from the PLATFORM ceiling, not from a preference. Cloud Run caps a
 * request body at 32 MB over HTTP/1.1, so the generated-files route's 50 MB
 * multer limit is unreachable there and a file between the two dies in the load
 * balancer with nothing the person can act on. 20 MB leaves room for the
 * multipart envelope and the other form fields inside the real ceiling.
 *
 * Comfortable for any screenshot or photograph. Small for video, which is the
 * point: a clip past this belongs in a link, and the alternative is an upload
 * that appears to work and is refused by infrastructure this code cannot see.
 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * How many images one TURN may send to a model, and how many bytes of them.
 *
 * Separate from MAX_MEDIA_ATTACHMENTS, which bounds one message. A turn carries
 * the current message plus whatever history the surface replays, and an image
 * is the largest single input a person can add: a 1500x1000 screenshot is about
 * 2000 tokens, so four of them on every turn of a long thread is a bigger
 * prompt than the entire conversation around them.
 */
export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES_PER_TURN = 12 * 1024 * 1024;

// ── Wire types ──────────────────────────────────────────────────────────

/** A file the person attached to this message. `content` is the extracted text
 *  the client sends, sanitized at the router boundary of whichever surface
 *  received it. */
export interface ChatUploadAttachment {
  kind: 'upload';
  name: string;
  content: string;
  addedAt: string;
}

/** A pointer at something living in a connected system. Only the name reaches
 *  the model today: nothing fetches the referenced record yet, and the
 *  identifiers are carried so that a later pass can without a contract change. */
export interface ChatConnectorAttachment {
  kind: 'connector';
  name: string;
  connectorId: string;
  connectorType: string;
  externalId: string;
  sourceUrl?: string;
  addedAt: string;
}

/**
 * A picture, clip or recording the person attached to this message.
 *
 * A THIRD member rather than a widening of `upload`, because `content` is read
 * unconditionally on every surface that handles an upload: making it
 * conditionally absent would turn a compile-time certainty into a runtime one
 * in code that has no reason to check. The bytes are not here and never travel
 * on a chat request — they were uploaded out of band and this carries the same
 * `MediaRef` the outbound path already puts on a message row.
 */
export interface ChatMediaAttachment {
  kind: 'media';
  /** The person's own file name, as the composer chip shows it. `media.filename`
   *  is the STORED name and carries a version suffix, so the two differ. */
  name: string;
  media: MediaRef;
  addedAt: string;
}

export type ChatAttachment =
  | ChatUploadAttachment
  | ChatConnectorAttachment
  | ChatMediaAttachment;

/**
 * What a message keeps about one attachment once its turn is over: enough to
 * render the chip again on reload, and nothing more.
 *
 * An upload's extracted text is deliberately absent. It is a one-turn model
 * input, not transcript, and eight of them at 4000 characters each would store
 * a second copy of every document the model has already read. A connector
 * reference keeps its identifiers, because they are small and they are what a
 * later pass would need to resolve the chip back to the record it points at.
 */
export type ChatMessageAttachment =
  | { kind: 'upload'; name: string }
  | {
      kind: 'connector';
      name: string;
      connectorType: string;
      connectorId: string;
      externalId: string;
      /** Only present when the client sent one. */
      sourceUrl?: string;
    };

// ── Request schema ──────────────────────────────────────────────────────

/**
 * One attachment as it arrives on a chat-stream request body.
 *
 * An upload carries its extracted text; a connector reference carries only a
 * pointer, because nothing fetches the referenced record yet. The union is
 * discriminated on `kind` so a body that mixes the two shapes is rejected at
 * the boundary rather than half-understood downstream.
 *
 * Every bound is set so that a message at the cap still fits a 50KB body.
 */
export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
    content: z.string().min(1).max(MAX_ATTACHMENT_CONTENT_CHARS),
    addedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('connector'),
    name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
    connectorId: z.string().min(1).max(200),
    connectorType: z.string().min(1).max(64),
    externalId: z.string().min(1).max(512),
    sourceUrl: z.string().url().max(2048).optional(),
    addedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('media'),
    name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
    media: mediaRefSchema,
    addedAt: z.string().datetime(),
  }),
]);

/**
 * The array form, capped, as a chat-stream body declares it.
 *
 * The outer bound stays MAX_ATTACHMENTS + MAX_MEDIA_ATTACHMENTS so a request at
 * both caps parses, and the per-kind counts are checked in `countAttachments`
 * below. Doing it in one `.max()` here would let twelve uploads through, which
 * is the cap the 50KB body limit was actually sized against.
 */
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS + MAX_MEDIA_ATTACHMENTS)
  .superRefine((list, ctx) => {
    const { text, media } = countAttachments(list);
    if (text > MAX_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_ATTACHMENTS} file attachments per message`,
      });
    }
    if (media > MAX_MEDIA_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_MEDIA_ATTACHMENTS} images or clips per message`,
      });
    }
  });

/** Attachments split by which cap they spend. A connector reference costs text
 *  budget (it becomes a name in the prompt), media costs tokens. */
export function countAttachments(
  attachments: readonly { kind: string }[],
): { text: number; media: number } {
  let text = 0;
  let media = 0;
  for (const a of attachments) {
    if (a.kind === 'media') media += 1;
    else text += 1;
  }
  return { text, media };
}

// ── Persistence projection ──────────────────────────────────────────────

/**
 * What the message keeps about its attachments once the turn is over.
 *
 * Dropping upload content happens HERE and nowhere else: every surface's path
 * from the request body into its messages table runs through this function, so
 * the omission is what keeps document text out of every transcript. A connector
 * reference keeps its identifiers, which are small and are what a later pass
 * would need to resolve the chip back to the record it points at.
 */
export function toMessageAttachments(
  attachments: readonly ChatAttachment[],
): ChatMessageAttachment[] {
  return attachments
    // Media is DELIBERATELY absent from this projection. It persists to the
    // message's own `media` column instead — see toMessageMedia below. Keeping
    // it here as well would put a MediaRef in two columns of the same row, and
    // putting it here INSTEAD would overload `attachments`: on
    // agent_chat_messages that column means "what the agent produced", so a
    // sent picture landing in it would make one column mean two different
    // things depending on the row's role.
    .filter((a): a is ChatUploadAttachment | ChatConnectorAttachment => a.kind !== 'media')
    .map((attachment) =>
      attachment.kind === 'upload'
        ? { kind: 'upload', name: attachment.name }
        : {
            kind: 'connector',
            name: attachment.name,
            connectorType: attachment.connectorType,
            connectorId: attachment.connectorId,
            externalId: attachment.externalId,
            // Omitted rather than stored as undefined: JSON.stringify would drop
            // the key anyway, and an explicit null would read back as a source
            // link that exists and is empty.
            ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
          },
    );
}

/**
 * The refs a message keeps in its `media` column, from the attachments its
 * request carried.
 *
 * The counterpart to toMessageAttachments, and the reason that one filters
 * rather than widens: the two together are the whole of what one turn's
 * attachments persist, and every surface calls both.
 *
 * The ref is stored WHOLE. Unlike an upload's text — dropped because it is a
 * one-turn model input the transcript should not carry a second copy of — a
 * MediaRef is metadata about bytes that live elsewhere, and it is exactly what
 * the renderer needs to draw the picture again when the thread is reopened.
 */
export function toMessageMedia(attachments: readonly ChatAttachment[]): MediaRef[] {
  return attachments
    .filter((a): a is ChatMediaAttachment => a.kind === 'media')
    .map((a) => a.media);
}

// ── Sanitizing ──────────────────────────────────────────────────────────
//
// Every router runs this before the text reaches a model or a table. It lives
// here rather than in one surface's router because all three take the same
// input and must make the same decisions about it.
//
// Neither names nor bodies are HTML-escaped. Escaping the body would corrupt
// the documents these assistants exist to work on: a source file would arrive
// as `&lt;div&gt;` and every apostrophe as `&#39;`, and the model would
// faithfully answer about the mangled text. Names used to be escaped, on the
// grounds that they are echoed back in replies, but that produced the same
// corruption one level down — a file called "Q3 P&L" was read back to the
// person as "Q3 P&amp;L". The single structural risk a name carries is breaking
// out of the `name="..."` attribute in the prompt, and that is handled where the
// attribute is built, in composeTurnText.

/**
 * One printable line, with control characters removed.
 *
 * The line collapse is the load-bearing half. HTML escaping never addressed it
 * — a newline passes through untouched — and a name that can insert a line
 * break can forge prompt structure that the `<attachment>` wrapper cannot
 * contain: `foo"\n</attachment>\n<attachment name="bar` is a name, and without
 * this it is also two tags.
 */
export function sanitizeAttachmentName(name: string): string {
  return stripControlChars(name).replace(/\s+/g, ' ').trim();
}

/**
 * Clean a whole list on its way in from a request body.
 *
 * An attachment whose name is nothing but control characters is DROPPED: it
 * cannot be named to the model, and an empty bullet in the prompt reads as a
 * bug.
 */
export function sanitizeAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] {
  if (!attachments) return [];
  return attachments
    .map((attachment): ChatAttachment => {
      if (attachment.kind === 'upload') {
        return {
          ...attachment,
          name: sanitizeAttachmentName(attachment.name),
          content: stripControlChars(attachment.content).trim(),
        };
      }
      if (attachment.kind === 'media') {
        // Both names are cleaned, and they are two different names: `name` is
        // what the person's file was called and what the chip shows, while
        // `media.filename` is the stored object's name and is what a prompt
        // notice or a download lands as. A ref that came back over the wire has
        // been through a client, so neither is trusted here.
        return {
          ...attachment,
          name: sanitizeAttachmentName(attachment.name),
          media: {
            ...attachment.media,
            filename: sanitizeAttachmentName(attachment.media.filename),
            ...(attachment.media.alt
              ? { alt: sanitizeAttachmentName(attachment.media.alt) }
              : {}),
          },
        };
      }
      return { ...attachment, name: sanitizeAttachmentName(attachment.name) };
    })
    .filter((attachment) => attachment.name.length > 0);
}

// ── Context budgeting ───────────────────────────────────────────────────
//
// A surface that accepts attachments must also make room for them, or the
// bodies it just accepted are truncated away before the model reads a word of
// them — silently, because a context budget reports no error. Every budget
// truncates the current message from its START, so a shortfall is paid for by
// the head of the first document going missing.

/** What composeTurnText wraps around one upload, beyond its content: the open
 *  tag, the newline after it, the closing tag, and the blank line that joins
 *  blocks. Counted from the template rather than estimated. */
const ATTACHMENT_WRAPPER_CHARS =
  '<attachment name="'.length
  + '">\n'.length
  + '\n</attachment>'.length
  + '\n\n'.length;

/** A router caps a name at MAX_ATTACHMENT_NAME_CHARS before it is escaped, and
 *  escaping is what reaches the model. One quote becomes `&quot;`, so a
 *  pathological name grows sixfold. Budget the worst case: being generous here
 *  costs a little headroom, being short costs the person their document. */
const MAX_ESCAPED_ATTACHMENT_NAME_CHARS = MAX_ATTACHMENT_NAME_CHARS * 6;

/**
 * Every character a router will accept in attachments — wrappers and escaped
 * names included — in tokens, at the four-characters-per-token estimate every
 * budget in this estate uses.
 *
 * Add this to the current-message section of any budget on a surface that takes
 * attachments, and to its total. A surface that accepts the field without
 * adding it will accept an 8 x 4000-character upload and show the model the
 * last few hundred characters of it.
 */
export const ATTACHMENT_ALLOWANCE_TOKENS =
  (MAX_ATTACHMENTS
    * (MAX_ATTACHMENT_CONTENT_CHARS
      + ATTACHMENT_WRAPPER_CHARS
      + MAX_ESCAPED_ATTACHMENT_NAME_CHARS))
  / 4;

/**
 * What a turn's IMAGES cost the same budget, when the model can see them.
 *
 * A separate constant because it is a different unit of the same account:
 * ATTACHMENT_ALLOWANCE_TOKENS converts characters at four per token, and an
 * image has no characters at all — its cost is pixels, on the vendors' own
 * width x height / 750. A budget that adds only the first one is exactly
 * accurate about text and silently wrong by a few thousand tokens per picture,
 * which is how an image pushes a person's own question out of the window.
 *
 * The worst case: MAX_IMAGES_PER_TURN images at the largest edge any vendor
 * keeps without resizing.
 */
export const IMAGE_ALLOWANCE_TOKENS =
  MAX_IMAGES_PER_TURN * estimateImageTokens({ width: 1568, height: 1568 });

/**
 * The notices for media the model will NOT see, in tokens.
 *
 * Small, and counted anyway. A video attachment produces prose in the prompt
 * whether or not the model can watch it, and a budget that knows about images
 * but not about the sentence explaining an unwatched clip is wrong in the one
 * case where the person gets no answer to compensate.
 */
export const MEDIA_NOTICE_ALLOWANCE_TOKENS = Math.ceil(
  (MAX_MEDIA_ATTACHMENTS * (300 + ATTACHMENT_WRAPPER_CHARS + MAX_ESCAPED_ATTACHMENT_NAME_CHARS))
    / 4,
);

// ── Prompt shaping ──────────────────────────────────────────────────────

/** Names as a system prompt lists them. A connector reference carries its
 *  type so the model can say where the thing lives. */
export function describeAttachment(attachment: ChatAttachment): string {
  if (attachment.kind === 'upload') return attachment.name;
  if (attachment.kind === 'media') return `${attachment.name} (${attachment.media.mimeType})`;
  return `${attachment.name} (${attachment.connectorType})`;
}

// ── What a model can and cannot look at ─────────────────────────────────

/**
 * The image types a vision-capable model is handed as a real image block.
 *
 * A SUBSET of the storage allow-list, and the difference is deliberate: the
 * store also accepts video and audio, which no model in this product can watch
 * or hear, and it accepts `image/gif`, which the vendors' image blocks take but
 * only as a still frame. GIF is included because a still frame of a screenshot
 * saved as a GIF is still the screenshot; what is excluded is everything that
 * has no still form at all.
 *
 * Every vendor this estate talks to accepts exactly these four. Keeping the
 * list here rather than per adapter is what stops one engine quietly deciding a
 * type is fine while another refuses it.
 */
const MODEL_READABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * The video types a video-capable model is handed as real video.
 *
 * Narrower than what the store accepts, and narrower than what the models
 * themselves list, because this is the intersection of three things: what we
 * store, what the vendors take inline, and what our adapters can express. mp4
 * and webm are the two that clear all three.
 */
const MODEL_READABLE_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

/** True when this media can be sent to a vision-capable model as an image. */
export function isModelReadableImage(mimeType: string): boolean {
  return MODEL_READABLE_IMAGE_TYPES.has(mimeType.toLowerCase());
}

/** True when this media can be sent to a video-capable model as video. */
export function isModelReadableVideo(mimeType: string): boolean {
  return MODEL_READABLE_VIDEO_TYPES.has(mimeType.toLowerCase());
}

/**
 * What this turn can actually put in front of the model.
 *
 * BOTH halves have to be true, and they are different questions asked of
 * different layers. `models.capabilities` answers "would this model understand
 * a video" — it is a property of the model, recorded from the vendor's own
 * catalogue. The adapter answers "can the code that will run this turn express
 * one" — Gemini's inlineData carries any blob, Anthropic's and OpenAI's image
 * blocks carry only images, and three engines take a text prompt and no media
 * at all.
 *
 * Collapsing the two would be wrong in both directions: a Gemini model on an
 * engine that cannot carry video, and a video-capable engine running a model
 * that cannot watch one, both have to end in the same place — described in
 * words, not sent and not dropped.
 */
export interface SendableModalities {
  image: boolean;
  video: boolean;
}

/**
 * The largest video that may ride INSIDE a request.
 *
 * The vendors accept inline media only up to a total request size — around
 * 20 MB for Gemini — and base64 inflates bytes by a third, so a file at the
 * platform's 20 MB storage cap is already over the wire limit before the prompt
 * is added. Anything larger is described rather than sent; carrying it would
 * mean a resumable file upload to the vendor and a handle, which is a different
 * feature and not one to fake with a bigger number here.
 */
export const MAX_INLINE_VIDEO_BYTES = 12 * 1024 * 1024;

/**
 * Split one turn's media into what the model will actually see and what it will
 * only be told about.
 *
 * `visionCapable` is the model's own capability, resolved from the registry. A
 * model without it gets NO image blocks and is told so — handing one an image
 * block is an error, not a degraded answer, and dropping the image silently
 * lets it answer confidently about a picture it never received.
 */
export function partitionMediaForModel(
  media: readonly MediaRef[],
  sendable: SendableModalities,
): { readable: MediaRef[]; described: MediaRef[] } {
  const readable: MediaRef[] = [];
  const described: MediaRef[] = [];
  let bytes = 0;
  for (const ref of media) {
    const asImage = sendable.image && isModelReadableImage(ref.mimeType);
    const asVideo = sendable.video && isModelReadableVideo(ref.mimeType);
    if (!asImage && !asVideo) {
      described.push(ref);
      continue;
    }
    // A video has its own ceiling, well below the storage cap, because it rides
    // inside the request body rather than beside it.
    if (asVideo && (ref.sizeBytes ?? 0) > MAX_INLINE_VIDEO_BYTES) {
      described.push(ref);
      continue;
    }
    // Per-turn ceilings, enforced HERE rather than in each of the eight places
    // that build a turn, so one surface cannot be generous by omission. What
    // does not fit is described rather than dropped.
    const size = ref.sizeBytes ?? 0;
    if (readable.length >= MAX_IMAGES_PER_TURN || bytes + size > MAX_IMAGE_BYTES_PER_TURN) {
      described.push(ref);
      continue;
    }
    readable.push(ref);
    bytes += size;
  }
  return { readable, described };
}

/**
 * The `<attachment>` block that tells a model about media it will not see.
 *
 * Said plainly, because the alternative is worse than saying nothing: a model
 * that is handed a filename and no image will describe the picture from its
 * name, and the person reading the answer has no way to tell that apart from
 * the model having looked. D5 in the plan is this sentence.
 */
export function composeMediaNotices(
  described: readonly MediaRef[],
  options: {
    /** Why this media is not being shown, when the reason is not the default
     *  one. There is more than one: the usual case is a model without vision,
     *  but a message delivered INTO a turn that is already running carries no
     *  image channel at all, and telling the model it has no vision when it
     *  does would be a different lie in the same place. */
    unavailableBecause?: string;
  } = {},
): string {
  if (described.length === 0) return '';
  return described
    .map((ref) => {
      const name = escapeAttachmentName(ref.filename);
      const why =
        options.unavailableBecause
        ?? (ref.mimeType.startsWith('image/')
          ? 'You cannot see this image: the model running this conversation has no vision capability.'
          : ref.mimeType.startsWith('video/')
            ? 'You cannot watch this video: either the model running this conversation cannot take video, or the clip is too large to send inline.'
            : `You cannot open this ${ref.mimeType.split('/')[0]} file.`);
      const alt = ref.alt ? `\nThe person described it as: ${ref.alt}` : '';
      return (
        `<attachment name="${name}" type="${escapeAttachmentName(ref.mimeType)}">\n${why}`
        + ' Say so if the person asks about it, and do not describe it from its file name.'
        + `${alt}\n</attachment>`
      );
    })
    .join('\n\n');
}

/**
 * A rough token cost for one image, on the vendors' own formula
 * (width x height / 750), used to keep a context budget honest.
 *
 * An estimate on purpose. The exact number depends on the vendor's tiling and
 * on whatever resizing it does server-side, and no caller here can know that
 * before sending. What a budget needs is an order of magnitude that is not
 * zero, which is what it was before this existed: images were absent from every
 * budget in this estate, so a turn carrying four of them counted as the length
 * of its text.
 *
 * Without dimensions, assumes the cap. Being generous costs headroom; being
 * short costs the person the head of their own question.
 */
export function estimateImageTokens(ref: Pick<MediaRef, 'width' | 'height'>): number {
  const width = ref.width ?? 1568;
  const height = ref.height ?? 1568;
  return Math.ceil((width * height) / 750);
}

/**
 * Make a file name safe to sit inside the `name="..."` attribute below.
 *
 * Only the double quote is encoded, and only here. The name is stored raw so
 * the chip in the UI reads like the file the person picked; the one thing it
 * must not do is close the attribute and open another, which is what
 * `evil" injected="yes` would otherwise do.
 *
 * Deliberately NOT a general HTML escape. Encoding `&` would hand the model
 * "Q3 P&amp;L" for a file called "Q3 P&L", which is the same corruption this
 * whole contract exists to remove — and inside an attribute value an ampersand
 * is structurally inert anyway. Newlines are handled upstream, where the name
 * is collapsed to a single line.
 */
export function escapeAttachmentName(name: string): string {
  return name.replace(/"/g, '&quot;');
}

/**
 * The text of the turn as the model sees it: attached file contents first, then
 * what the person typed.
 *
 * The order is load-bearing. A context budget truncates the current message
 * from its start, so a turn that overflows loses document body rather than the
 * question being asked about it.
 */
export function composeTurnText(
  userMessage: string,
  attachments: readonly ChatAttachment[] = [],
  options: {
    /** Media this turn will NOT send as an image block, from
     *  partitionMediaForModel. Passed in rather than derived here because the
     *  caller has already had to split the list to build the image blocks, and
     *  partitioning twice is how the notice and the blocks start disagreeing
     *  about which picture the model got. */
    describedMedia?: readonly MediaRef[];
    /** Passed straight through to composeMediaNotices. */
    unavailableBecause?: string;
  } = {},
): string {
  const uploads = attachments.filter(
    (a): a is ChatUploadAttachment => a.kind === 'upload' && a.content.length > 0,
  );
  const blocks = uploads.map(
    (u) => `<attachment name="${escapeAttachmentName(u.name)}">\n${u.content}\n</attachment>`,
  );
  const notices = composeMediaNotices(options.describedMedia ?? [], {
    ...(options.unavailableBecause ? { unavailableBecause: options.unavailableBecause } : {}),
  });
  if (notices) blocks.push(notices);
  if (blocks.length === 0) return userMessage;
  return `${blocks.join('\n\n')}\n\n${userMessage}`;
}
