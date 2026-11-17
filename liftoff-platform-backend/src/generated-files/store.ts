// Generated-files storage: the one place bytes become a stored artifact.
//
// Extracted from the body of POST /api/generated-files so that the route and
// IN-PROCESS callers share one implementation. The platform agents (Liftoff,
// the Insights Manager) run inside this process; having them HTTP-POST to
// their own server to store a file would be a second storage path pretending
// to be the same one, and the two would drift. The route is now a thin HTTP
// wrapper over storeMediaObject().
//
// The enum, the extension map and the content-type map live here rather than
// in the router for the same reason: the media attach helper (src/media/) has
// to agree with the route about what a stored object's content type is, and
// agreement is cheapest when there is only one definition to agree with.

import crypto from 'crypto';
import { z } from 'zod';
import { withTenantScope } from '../infrastructure/database';
import { generatedFilesBucket } from './gcs-client';
import { log } from '../infrastructure/logging';

// Document outputs from generation pipelines (xlsx/docx/etc.) plus
// browser-sourced artifacts that flow through the same /api/generated-files
// → file_output assistant message → FileOutputCard render surface:
//   - 'pdf'    — tenant-runtime calls Anchor /v1/tools/page-pdf to snapshot
//                the user's live browser page and surfaces it as an inline
//                attachment ("save this article as PDF").
//   - 'binary' — tenant-runtime fetches a file the user (or Anchor's
//                in-session agent) downloaded inside the browser session
//                and surfaces it inline ("process the invoice I just
//                downloaded"). The mime type and extension come from the
//                upload's multipart Content-Type / suggested filename
//                since browser downloads can be anything.
//   - 'media'  — an image, video or audio clip the agent produced FOR THE
//                PERSON to look at, rather than a document it authored. It is
//                typed by MIME (see MEDIA_MIME_ALLOWLIST) rather than by a new
//                enum member per format, because what the browser needs to
//                know is how to present the bytes, not what kind of document
//                they are.
//   - 'gdoc'   — a native Google Doc, the sibling of 'gslides': it lives in
//                the connector, has no bytes here and no extension. Registered
//                connector-natively by the tenant runtime when a team copies
//                and edits a Google Doc in the user's Drive. Not 'docx': the
//                filename is built as `${baseName}_v${n}.${ext}`, so a Google
//                Doc registered as docx would card as `Report_v1.docx` beside a
//                URL that opens a Google Doc, with a Download button pointing
//                at bytes that do not exist.
//
// The CHECK constraint on generated_files.output_type mirrors this list
// (migration 473 is the latest); output-type-constraint.test.ts holds the two
// together.
export const outputTypeSchema = z.enum([
  'xlsx',
  'docx',
  'docx_redlined',
  'pptx',
  'gslides',
  'gdoc',
  'pdf',
  'binary',
  'media',
]);

export type OutputType = z.infer<typeof outputTypeSchema>;

/**
 * The output types that describe a DOCUMENT the agent authored, which is
 * everything a connector-native registration can be.
 *
 * 'media' is excluded: a connector-native row has no bytes and no GCS object,
 * so there is nothing to type by MIME and nothing for a renderer to draw. It
 * would land as a `file_output` card named after a picture nobody can open.
 */
export const documentOutputTypeSchema = outputTypeSchema.exclude(['media']);

/** A media type the platform will not store. Thrown rather than returned so a
 *  caller cannot mistake a refusal for a stored object. */
export class UnsupportedMediaTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported media type "${mimeType || 'none'}" — accepted: ${MEDIA_TYPES_HUMAN}`);
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * Media types the platform will store as 'media' and serve inline, and the file
 * extension each one is stored under.
 *
 * ONE table, because the allow-list, the human-readable list in the 400 a
 * producer gets, and the extension map are three views of one fact. Written as
 * three separate constants they drift, and the drift is silent: a type accepted
 * by the matcher but missing from the extension map lands as a file with no
 * extension, and one missing from the message tells the producer its own MIME
 * is not on a list that contains it.
 *
 * Matched WHOLE, never by prefix, on the model of this repo's only other binary
 * MIME check (src/voice/chat-audio.ts). Equivalent to
 * `^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|mp4|webm|ogg))$`,
 * enumerated so the extension can hang off each entry.
 *
 * `image/svg+xml` is EXCLUDED, deliberately and permanently. An SVG is
 * executable markup: it can carry <script>, and it is served from a URL the
 * browser renders in the user's origin, so accepting one turns a producer that
 * can name its own bytes into a stored-XSS vector. Nothing in this product
 * needs an agent to publish vector markup; if that ever changes it needs its
 * own sanitising pipeline, not a wider entry here.
 */
const MEDIA_TYPE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
} as const;

export type MediaMimeType = keyof typeof MEDIA_TYPE_EXTENSIONS;

/** The allow-list in words, for the 400 a producer gets when it sends
 *  something else. Derived from the table, so it cannot disagree with it. */
export const MEDIA_TYPES_HUMAN = Object.keys(MEDIA_TYPE_EXTENSIONS).join(', ');

/** Normalize a producer's declared content type for lookup. A multipart part
 *  may carry parameters (`image/jpeg; charset=binary`) and any casing. */
function normalizeMimeType(mimeType: string | undefined | null): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** True when a producer-supplied content type may be stored as 'media'. */
export function isAllowedMediaMimeType(mimeType: string | undefined | null): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized in MEDIA_TYPE_EXTENSIONS;
}

/** The allow-listed type in its canonical form, or null. This is what gets
 *  stored on the GCS object and in `mime_type`, so a producer's casing or
 *  stray parameters never reach the renderer. */
export function canonicalMediaMimeType(mimeType: string | undefined | null): MediaMimeType | null {
  const normalized = normalizeMimeType(mimeType);
  return normalized in MEDIA_TYPE_EXTENSIONS ? (normalized as MediaMimeType) : null;
}

/** File extension for an allow-listed media type. Driven by the MIME rather
 *  than by the producer's filename: the MIME is what decides how the object is
 *  served, so letting the two disagree would put `.txt` on an `image/png`. */
function mediaMimeToExt(mimeType: string): string {
  const canonical = canonicalMediaMimeType(mimeType);
  return canonical ? MEDIA_TYPE_EXTENSIONS[canonical] : '';
}

/** Default extension by outputType. For 'binary' (arbitrary browser
 *  download), the caller's suggested filename already carries the
 *  extension — outputTypeToExt returns '' and the upload route falls
 *  back to the suggested filename verbatim. For 'media' the extension comes
 *  from the uploaded MIME type, which is the authority on how the bytes are
 *  served. */
export function outputTypeToExt(outputType: OutputType, uploadedMimeType?: string): string {
  if (outputType === 'xlsx') return 'xlsx';
  if (outputType === 'pptx') return 'pptx';
  if (outputType === 'pdf') return 'pdf';
  if (outputType === 'gslides' || outputType === 'gdoc') return ''; // Google-native files have no extension
  if (outputType === 'binary') return ''; // ext comes from the original filename
  if (outputType === 'media') return mediaMimeToExt(uploadedMimeType ?? '');
  return 'docx'; // both 'docx' and 'docx_redlined' produce .docx files
}

export function outputTypeToContentType(outputType: OutputType, uploadedMimeType?: string): string {
  if (outputType === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (outputType === 'pptx') {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (outputType === 'pdf') return 'application/pdf';
  // 'gslides' is a Google-native file; the upload buffer just carries
  // the .docx pre-conversion artifact. Keep the wordprocessingml
  // content-type for the GCS object — the connector swap to a Google
  // Slides object happens through PATCH webViewUrl downstream.
  if (outputType === 'binary') return 'application/octet-stream';
  // The content type is the whole point of a media object: platform-backend
  // sets no Content-Disposition anywhere, so an object stored image/png is
  // served inline and renders in an <img> with no further work, while one
  // stored application/octet-stream never will.
  //
  // A type outside the allow-list THROWS rather than falling back. Storing the
  // bytes as application/octet-stream would be a silent downgrade: the upload
  // would report success and the media would never draw, which is the failure
  // mode this whole path exists to remove. Both callers screen first, so this
  // is the backstop that keeps a third one from getting it wrong.
  if (outputType === 'media') {
    const canonical = canonicalMediaMimeType(uploadedMimeType);
    if (!canonical) throw new UnsupportedMediaTypeError(uploadedMimeType ?? '');
    return canonical;
  }
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export interface StoreMediaObjectInput {
  tenantId: string;
  /** internal_agents.id of the PRODUCER. Null for a file a person uploaded,
   *  which has no producing agent — `uploadedByAccountId` names the owner
   *  instead, and exactly one of the two is set. */
  agentId: string | null;
  /** accounts.id of the person who uploaded this, for inbound media. Null for
   *  anything an agent produced. */
  uploadedByAccountId?: string | null;
  /** Which chat surface `conversationId` belongs to. Thread ids on the four
   *  surfaces live in four different tables (and, for the Chief AI Officer, a
   *  different database), so the id alone does not say what it points at. */
  surface?: string | null;
  /** Human-meaningful base name, no extension. Versioned per (owner, baseName). */
  baseName: string;
  outputType: OutputType;
  bytes: Buffer;
  /** The producer's own filename. Load-bearing for 'binary', where the
   *  extension comes from it; a hint everywhere else. */
  originalFilename: string;
  /** The producer's declared content type. Honoured for 'binary' and, once
   *  allow-listed, for 'media'. Ignored for the enum-typed document outputs,
   *  whose content type is implied by outputType. */
  uploadedMimeType?: string;
  /** Thread the artifact belongs to, when it has one. Persisted on the row so
   *  a later read can scope the file to the conversation it came from. */
  conversationId?: string | null;
  /**
   * When these bytes are discarded if nobody publishes them.
   *
   * Omitted (or null) stores an artifact: something a person has been shown, or
   * will be in the same request, and which is kept. A date stores STAGED bytes:
   * they exist, they are attributed, and they are announced nowhere. Presenting
   * the file clears the column, so publishing is what makes a file permanent.
   *
   * A producer that stages must say so. The default is to keep, because a file
   * silently given a lifetime is a file that disappears from under whoever was
   * relying on it.
   */
  discardAfter?: Date | null;
  /**
   * Whether to mint a signed URL for the stored object.
   *
   * REQUIRED, with no default, because the honest answer differs per caller and
   * a default would hide the cost from whoever gets it wrong. On Cloud Run
   * there is no private key, so signing is not local arithmetic — it is a round
   * trip to the IAM credentials API, on the critical path of an upload the
   * person is waiting on.
   *
   * A producer needs one: it answers its HTTP caller with a `downloadUrl`. An
   * INBOUND upload does not — it returns a reference, and the browser mints its
   * own URL through the download route when it renders. That path paid for a
   * URL it discarded on every single upload.
   */
  signUrl: boolean;
}

export interface StoredMediaObject {
  id: string;
  filename: string;
  version: number;
  gcsPath: string;
  /** The content type the object was actually stored under. */
  mimeType: string;
  sizeBytes: number;
  /** 1 hour, from the moment of the write. Re-mint with the download route.
   *  Empty when the caller asked not to sign (`signUrl: false`). */
  signedUrl: string;
}

/**
 * Store bytes as a generated-files artifact: version, name, upload, row,
 * signed URL. No message is appended and no audit log is written — those are
 * the caller's, because they differ between a document (a `file_output`
 * message) and media (a `media` MediaRef on the message row).
 */
export async function storeMediaObject(
  input: StoreMediaObjectInput,
): Promise<StoredMediaObject> {
  const startedAt = Date.now();
  const { tenantId, agentId, baseName, outputType, bytes, originalFilename } = input;
  const uploadedByAccountId = input.uploadedByAccountId ?? null;

  // Who owns this file. Three shapes, and exactly one of them holds:
  //
  //   an agent produced it      agent_id
  //   a person uploaded it        uploaded_by_account_id
  //   an assistant produced it    neither, and the CONVERSATION owns it
  //
  // The third is not a hole left by the other two. The three platform
  // assistants have no `internal_agents` row — `agent_id` is a foreign key
  // into that table — and the person they are talking to did not upload
  // anything, so filing it under either would be a lie of the kind migration
  // 393 exists to prevent: it would put a file in some agent's audit trail,
  // or make a person's retention sweep delete an assistant's work. What is
  // true is the conversation it was made in, so that is what is recorded.
  const conversationOwned = !agentId && !uploadedByAccountId;
  if (conversationOwned && !(input.conversationId && input.surface)) {
    // Still refused when there is no owner of ANY kind: the row would belong
    // to nobody, version against nothing, and land at a GCS path with a hole
    // in it — an object no retention rule can reason about.
    throw new Error(
      'storeMediaObject requires an agentId, an uploadedByAccountId, or a conversationId with its surface',
    );
  }

  // 1. Determine next version for this (owner, baseName) pair.
  // generated_files is RLS-scoped on tenant_id — run within tenant scope.
  //
  // One statement per owner shape, never one with a null-tolerant predicate:
  // `agent_id = NULL` is never true, so a merged query would silently version
  // everything as v1 and two screenshots of the same name in one thread would
  // be indistinguishable in the file list.
  const versionResult = await withTenantScope(tenantId, (client) => {
    if (agentId) {
      return client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM generated_files
          WHERE agent_id = $1 AND base_name = $2`,
        [agentId, baseName],
      );
    }
    if (uploadedByAccountId) {
      return client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM generated_files
          WHERE uploaded_by_account_id = $1 AND base_name = $2`,
        [uploadedByAccountId, baseName],
      );
    }
    // Conversation-owned: an assistant's second screenshot of the same page in
    // the same conversation is _v2, and the identically named one in the next
    // conversation starts again at _v1 — which is what a person reading one
    // thread expects to see.
    return client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM generated_files
        WHERE conversation_id = $1 AND surface = $2 AND base_name = $3
          AND agent_id IS NULL AND uploaded_by_account_id IS NULL`,
      [input.conversationId, input.surface, baseName],
    );
  });
  const version: number = Number(versionResult.rows[0].next_version);

  // 2. Compose filename + content-type.
  // For 'binary' (browser-source downloads), the extension comes
  // from originalFilename (Anchor's suggested_file_name) and
  // the content-type from the upload's own MIME — browser downloads
  // can be anything; we can't enum them.
  let filename: string;
  let storedContentType: string;
  if (outputType === 'binary') {
    const dot = originalFilename.lastIndexOf('.');
    const origExt = dot >= 0 ? originalFilename.slice(dot + 1) : '';
    filename = origExt ? `${baseName}_v${version}.${origExt}` : `${baseName}_v${version}`;
    storedContentType = input.uploadedMimeType || outputTypeToContentType(outputType);
  } else {
    const ext = outputTypeToExt(outputType, input.uploadedMimeType);
    filename = ext ? `${baseName}_v${version}.${ext}` : `${baseName}_v${version}`;
    storedContentType = outputTypeToContentType(outputType, input.uploadedMimeType);
  }

  const tVersion = Date.now();

  // 3. Upload to GCS.
  // Produced files sit under the agent that made them; uploads sit under the
  // person who sent them. Both stay inside the tenant prefix, which is what the
  // download route's membership check is ultimately protecting.
  const ownerPrefix = agentId ? `agents/${agentId}` : `uploads/${uploadedByAccountId}`;
  const gcsPath = `tenants/${tenantId}/${ownerPrefix}/${crypto.randomUUID()}/${filename}`;
  const bucket = generatedFilesBucket();
  const gcsFile = bucket.file(gcsPath);

  await gcsFile.save(bytes, {
    contentType: storedContentType,
    resumable: false,
  });
  const tUpload = Date.now();

  // 4. Insert DB row (within tenant scope so RLS WITH CHECK passes).
  const sizeBytes = bytes.length;
  const insertResult = await withTenantScope(tenantId, (client) =>
    client.query(
      `INSERT INTO generated_files
         (tenant_id, agent_id, conversation_id, filename, base_name, version, output_type,
          gcs_path, size_bytes, mime_type, uploaded_by_account_id, surface, discard_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        tenantId,
        agentId,
        input.conversationId ?? null,
        filename,
        baseName,
        version,
        outputType,
        gcsPath,
        sizeBytes,
        storedContentType,
        uploadedByAccountId,
        input.surface ?? null,
        input.discardAfter ?? null,
      ],
    ),
  );

  const row = insertResult.rows[0] as { id: string };
  const tInsert = Date.now();

  // 5. Generate signed URL (1 hour) — only when the caller will use it.
  //
  // Skipped rather than made lazy: this is one awaited network call to the IAM
  // credentials API (there is no private key on Cloud Run to sign with locally),
  // and it sits on the critical path of a request a person is watching a
  // progress bar for.
  const signedUrl = input.signUrl
    ? (
        await gcsFile.getSignedUrl({
          action: 'read',
          expires: Date.now() + 3_600_000,
        })
      )[0]
    : '';

  // Where the time actually went.
  //
  // Logged because "the upload feels slow" is not something anybody can act on:
  // the request spans a browser's upstream bandwidth, a load balancer, a
  // version query, a GCS write, an insert and possibly an IAM signing call, and
  // the only number visible from outside is their sum. A 220KB upload taking
  // four seconds and a 2.5MB one taking eight look identical from the client
  // and have completely different causes.
  log.info(
    {
      event: 'generated_files_store_timing',
      outputType,
      sizeBytes,
      versionMs: tVersion - startedAt,
      uploadMs: tUpload - tVersion,
      insertMs: tInsert - tUpload,
      signMs: Date.now() - tInsert,
      totalMs: Date.now() - startedAt,
    },
    'generated-files: stored an object',
  );

  return {
    id: row.id,
    filename,
    version,
    gcsPath,
    mimeType: storedContentType,
    sizeBytes,
    signedUrl,
  };
}
