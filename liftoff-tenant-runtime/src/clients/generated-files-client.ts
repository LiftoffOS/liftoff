// Tenant-runtime client for platform-backend's /api/generated-files.
//
// Why this exists: tenant-runtime produces file artifacts that should
// flow through the SAME inline-rendering surface as the existing
// document/spreadsheet/presentation generation pipeline — Anchor
// snapshots of the live browser page (PDFs), files the user
// downloaded inside the browser session, etc. The control plane owns
// the storage, the file-output assistant message append, and the
// signed-URL refresh endpoint, so a TR tool just hands it the bytes
// and gets back a generatedFileId / downloadUrl that the existing
// React FileOutputCard renders as a card next to the agent's reply.
//
// PB endpoint: POST /api/generated-files (multipart/form-data) —
//   - field "file" → raw bytes (multer single-file)
//   - body: { agentId, tenantId, baseName, outputType, conversationId? }
//   - outputType is the enum from generated-files/store.ts; for
//     browser-sourced artifacts: 'pdf' for page snapshots, 'binary'
//     for arbitrary downloads (mime + ext flow from the multipart
//     part's Content-Type and original filename), 'media' for images,
//     video and audio the person is meant to SEE inline in the thread.

import { getPlatformBackendUrl } from '../infrastructure/runtime-env';
import { fetchWithOidc } from '../infrastructure/oidc-fetch';
import { logger } from '../infrastructure/logging';
import { getManagedSecret } from '../infrastructure/secret-store';

/** The shared control-plane service token, the same one every other
 *  platform-backend call in this repo presents. Thrown for rather than
 *  defaulted to empty: an upload that silently authenticates as nobody comes
 *  back as a 401 with the bytes already produced, which is exactly the failure
 *  this function existed with for two months. */
function requireServiceToken(): string {
  const token = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!token) {
    throw new Error('TENANT_RUNTIME_SERVICE_TOKEN is required to reach /api/generated-files');
  }
  return token;
}

export interface UploadGeneratedFileInput {
  tenantId: string;
  agentId: string;
  /** Thread / conversation id — when present, PB appends a file_output
   *  assistant message to this conversation so the file renders inline. */
  conversationId?: string;
  /** Human-meaningful base name (no extension). PB auto-versions per
   *  (agent, baseName) so multiple snapshots of the same artifact stack. */
  baseName: string;
  /** Output type — controls how PB labels and stores the file. 'pdf'
   *  for Anchor active-page snapshots; 'binary' for arbitrary browser
   *  downloads where the actual content-type comes from `contentType`;
   *  'media' for an image, video or audio clip the agent produced FOR THE
   *  PERSON to look at, which PB stores under the MIME in `contentType` and
   *  references from the message's own `media` column rather than as a
   *  file-output document card. */
  outputType: 'pdf' | 'binary' | 'media' | 'xlsx' | 'docx' | 'docx_redlined' | 'pptx' | 'gslides';
  /** Raw file bytes. */
  bytes: Buffer;
  /** Original filename — load-bearing for 'binary' uploads where PB
   *  derives the extension from it. For typed outputs ('pdf', 'xlsx',
   *  …), PB uses its enum-driven extension and this is just a hint. */
  filename: string;
  /** MIME type — load-bearing for 'binary' and 'media' uploads where PB
   *  stores it on the GCS object so downloads serve with the right type. For
   *  'media' it is also what decides whether the upload is accepted at all:
   *  PB refuses anything outside its media allow-list, SVG included. For
   *  typed outputs, PB uses its enum-driven content-type and this is
   *  ignored. */
  contentType: string;
}

export interface UploadGeneratedFileResult {
  generatedFileId: string;
  filename: string;
  version: number;
  /** 1-hour signed URL. To get a fresh one later, call
   *  GET /api/generated-files/:id/download. */
  downloadUrl: string;
}

/** Upload a file's bytes to platform-backend so it lands in the
 *  generated_files table + appears as an inline file_output card in
 *  the user's chat. Returns the new row's id and a short-lived signed
 *  URL. Throws on non-2xx. */
export async function uploadGeneratedFile(
  input: UploadGeneratedFileInput,
): Promise<UploadGeneratedFileResult> {
  const url = `${getPlatformBackendUrl()}/api/generated-files`;
  const form = new FormData();
  // Native FormData/Blob exist in Node 20.
  const blob = new Blob([new Uint8Array(input.bytes)], { type: input.contentType });
  form.append('file', blob, input.filename);
  form.append('agentId', input.agentId);
  form.append('tenantId', input.tenantId);
  form.append('baseName', input.baseName);
  form.append('outputType', input.outputType);
  if (input.conversationId) form.append('conversationId', input.conversationId);

  const res = await fetchWithOidc(url, {
    method: 'POST',
    body: form,
    // The service token, which this call has never sent.
    //
    // PB's POST /api/generated-files sits behind `serviceAuthMiddleware`, which
    // reads `x-service-auth` and answers 401 without it. OIDC gets the request
    // past Cloud Run's ingress and no further — the two are different gates,
    // and only the outer one was being satisfied. Every browser PDF snapshot
    // and every browser download this client has ever uploaded was refused at
    // the application layer, after Anchor had already produced the file.
    headers: { 'X-Service-Auth': requireServiceToken() },
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn(
      { status: res.status, body: text.slice(0, 500), tenantId: input.tenantId, agentId: input.agentId },
      'uploadGeneratedFile: non-2xx from /api/generated-files',
    );
    throw new Error(`uploadGeneratedFile: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { id: string; filename: string; version: number; downloadUrl: string };
  return {
    generatedFileId: json.id,
    filename: json.filename,
    version: json.version,
    downloadUrl: json.downloadUrl,
  };
}


/**
 * Read one stored media object's bytes back out of the control plane.
 *
 * The counterpart to the upload above, and the reason it cannot simply reuse
 * `GET /api/generated-files/:id/download`: that route answers with a signed URL
 * and is authenticated by a person's Firebase token, neither of which a service
 * has. `:id/content` is its service-auth sibling and answers with the bytes.
 *
 * Bytes rather than a URL because of what they are for. A vendor takes an image
 * as base64 inside the request body; it will not fetch a link out of a private
 * bucket, and every URL this platform can mint for one expires in an hour.
 *
 * Returns null rather than throwing when the object cannot be read. A missing
 * or foreign media id must cost the turn its picture, not the turn itself — the
 * control plane already told the model in words that some media could not be
 * shown, and one more unreadable item joins that list.
 */
export async function fetchMediaBytes(
  tenantId: string,
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const url =
    `${getPlatformBackendUrl()}/api/generated-files/${encodeURIComponent(mediaId)}/content`
    + `?tenantId=${encodeURIComponent(tenantId)}`;
  try {
    const res = await fetchWithOidc(url, {
      headers: { 'X-Service-Auth': requireServiceToken() },
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, tenantId, mediaId },
        'fetchMediaBytes: non-2xx from /api/generated-files/:id/content',
      );
      return null;
    }
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim();
    if (!mimeType) return null;
    return { bytes: Buffer.from(await res.arrayBuffer()), mimeType };
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, tenantId, mediaId },
      'fetchMediaBytes: could not read stored media',
    );
    return null;
  }
}

/** What presenting a file answers with: enough to say what a person now sees. */
export interface PresentGeneratedFileResult {
  filename: string;
  outputType: string;
  version: number;
}

/**
 * Show a file that is already in the workspace, in one conversation.
 *
 * The counterpart to uploading: that puts bytes somewhere durable, this puts a
 * card in front of a person. They are separate because writing a file and
 * publishing it are separate decisions — a file fetched from a provider, or
 * produced by a run nobody was watching, has no conversation of its own, and
 * which one shows it is decided here by whoever is replying.
 *
 * `agentId` must be the control-plane `internal_agents.id`, not the runtime's
 * own agent id (ADR-039). A wrong-space id matches no row and the card is
 * attributed to nobody.
 */
export async function presentGeneratedFile(input: {
  tenantId: string;
  internalAgentId: string;
  generatedFileId: string;
  conversationId: string;
  turnId?: string | null;
}): Promise<PresentGeneratedFileResult> {
  const url = `${getPlatformBackendUrl()}/api/generated-files/${encodeURIComponent(input.generatedFileId)}/present`;
  const res = await fetchWithOidc(url, {
    method: 'POST',
    headers: {
      'X-Service-Auth': requireServiceToken(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      surface: 'agent_chat',
      agentId: input.internalAgentId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    }),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn(
      { status: res.status, body: text.slice(0, 500), tenantId: input.tenantId, generatedFileId: input.generatedFileId },
      'presentGeneratedFile: non-2xx from /api/generated-files/:id/present',
    );
    throw new Error(`presentGeneratedFile: ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json() as PresentGeneratedFileResult;
}
