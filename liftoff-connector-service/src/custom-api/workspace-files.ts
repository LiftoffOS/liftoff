// The bridge to the workspace's one file store.
//
// A custom API answers with bytes as readily as it answers with JSON: an
// invoice PDF, an exported CSV, a generated image. Those bytes must not go
// where a JSON answer goes. A model cannot read a PDF and must never be handed
// one as text — which is what happened before this: a binary response fell
// through to `{ text }` and reached the model as mangled UTF-8, a successful
// call that looks like corrupt data.
//
// There is exactly one file store and this reaches it rather than building a
// second: platform-backend's `attach.ts` is the single helper every producer
// calls (ADR-051), and a file an AI team pulls from an API is the same kind of
// thing as a file it generated. That is why a person sees it in the same
// place, with the same card, and can open it the same way.
//
// What travels back to the model is a HANDLE — an id, a name, a type, a size —
// and never the bytes. The bytes went to the store; the model gets what it
// needs to talk about the file and nothing it cannot read.

import { logger } from '../infra/logging.js';

/** What a stored file is, to whoever asked for it. */
export interface StoredWorkspaceFile {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Short-lived. A surface re-mints it rather than keeping this. */
  downloadUrl?: string;
}

export class WorkspaceFileError extends Error {
  readonly reason: 'not_configured' | 'no_agent' | 'rejected' | 'unreachable';
  constructor(reason: WorkspaceFileError['reason'], message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.reason = reason;
  }
}

function backendBase(): string {
  const base = process.env.BACKEND_URL;
  if (!base) {
    throw new WorkspaceFileError(
      'not_configured',
      'custom_api: this environment has no BACKEND_URL, so a file cannot be put in the workspace.',
    );
  }
  return base.replace(/\/+$/, '');
}

function serviceToken(): string {
  const token = process.env.PLATFORM_CALLBACK_TOKEN;
  if (!token) {
    throw new WorkspaceFileError(
      'not_configured',
      'custom_api: this environment has no PLATFORM_CALLBACK_TOKEN, so a file cannot be put in the workspace.',
    );
  }
  return token;
}

/** How long a file transfer may take. Longer than an ordinary call: these are
 *  bytes, and the store is a second hop. */
const TRANSFER_TIMEOUT_MS = 60_000;

/**
 * How long bytes a provider answered with survive unpublished.
 *
 * A fetched file is STAGED, not an artifact: nothing yet knows whether a person
 * will ever be shown it, and most are read once and never mentioned again. The
 * AI team presents the ones that matter, and presenting clears the lifetime, so
 * this only ever reaches files nobody put in front of anyone.
 *
 * Seven days, matching the dataset parking window: long enough that a file
 * fetched in one turn can still be presented in a later conversation, short
 * enough that a workspace does not accumulate every byte every API ever
 * returned.
 */
const STAGED_FOR_SECONDS = 7 * 24 * 60 * 60;

/**
 * Put bytes in the workspace, and get back what a model can talk about.
 *
 * `agentId` is the producer the file is attributed to. It is REQUIRED by the
 * store and there is no sensible stand-in: a file with no producer is one
 * nobody can be asked about later. A caller that has none gets a refusal
 * naming that, rather than a file filed under a fiction.
 *
 * The thread is deliberately not passed. Storing and showing are different
 * decisions: this puts the bytes somewhere durable, and the AI team that knows
 * which conversation asked is the one that presents it. That is also why the
 * file is stored STAGED — it is kept only once somebody shows it to a person.
 */
export async function storeWorkspaceFile(args: {
  tenantId: string;
  agentId: string | undefined;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<StoredWorkspaceFile> {
  if (!args.agentId) {
    throw new WorkspaceFileError(
      'no_agent',
      'custom_api: this call answered with a file, and the request carried no agent to attribute it to, '
      + 'so there is nowhere to put it. The bytes were not kept.',
    );
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(args.bytes)], { type: args.mimeType }), args.filename);
  form.append('tenantId', args.tenantId);
  form.append('agentId', args.agentId);
  form.append('baseName', args.filename);
  // `media` for the kinds a person looks at; everything else is a document,
  // which is the store's own distinction and the reason it renders one as a
  // picture and the other as a card.
  form.append('outputType', args.mimeType.startsWith('image/') ? 'media' : 'document');
  // Stored, attributed, and announced nowhere until an AI team presents it.
  form.append('discardAfterSeconds', String(STAGED_FOR_SECONDS));

  let response: Response;
  try {
    response = await fetch(`${backendBase()}/api/generated-files`, {
      method: 'POST',
      headers: { 'X-Service-Auth': serviceToken() },
      body: form,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WorkspaceFileError(
      'unreachable',
      `custom_api: the file store could not be reached (${(err as Error).message}).`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new WorkspaceFileError(
      'rejected',
      `custom_api: the file store refused this file (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const body = (await response.json()) as {
    id?: string;
    fileId?: string;
    filename?: string;
    mimeType?: string;
    downloadUrl?: string;
  };
  const fileId = body.id ?? body.fileId;
  if (!fileId) {
    throw new WorkspaceFileError('rejected', 'custom_api: the file store answered without an id.');
  }
  logger.info(
    { tenantId: args.tenantId, fileId, mimeType: args.mimeType, sizeBytes: args.bytes.length },
    'custom_api_file_stored',
  );
  return {
    fileId,
    filename: body.filename ?? args.filename,
    mimeType: body.mimeType ?? args.mimeType,
    sizeBytes: args.bytes.length,
    ...(body.downloadUrl ? { downloadUrl: body.downloadUrl } : {}),
  };
}

/**
 * Read a file the workspace already holds, by the id a model named.
 *
 * This is the upload half: a model cannot hold bytes, so what it names is a
 * file that is already there — one an AI team generated, or one a person
 * attached — and the bytes are fetched here and put in the request. The model
 * never sees them.
 */
export async function readWorkspaceFile(args: {
  tenantId: string;
  fileId: string;
}): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  const url = `${backendBase()}/api/generated-files/${encodeURIComponent(args.fileId)}/content`
    + `?tenantId=${encodeURIComponent(args.tenantId)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'X-Service-Auth': serviceToken() },
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WorkspaceFileError(
      'unreachable',
      `custom_api: the file store could not be reached (${(err as Error).message}).`,
    );
  }

  if (!response.ok) {
    throw new WorkspaceFileError(
      'rejected',
      `custom_api: no file in this workspace has the id ${args.fileId} (${response.status}).`,
    );
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    filename: named ? decodeURIComponent(named) : args.fileId,
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}
