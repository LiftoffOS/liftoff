// A file the team FOUND becomes a card, the same as a file it made.
//
// The chat surface already draws a proper file card — filename, source badge,
// download, open-in-Drive — and Slack and Teams render the same card from the
// same rows. Every producer of those rows was a tool that CREATED a file
// (`register-connector-native` for a Slides deck written into Drive, the GCS
// path for a generated document). A file the team merely located and handed
// to the person came back as tool output, and the model pasted its URL into
// the reply as text. Two producers, one renderer, one of them never wired.
//
// This is the other producer. On a successful single-file read from a cloud
// storage connector during an INTERACTIVE turn, the file is registered
// connector-natively — no bytes, no GCS object, the row points at the file
// where it lives — and the existing `file_output` message, card, and channel
// rendering follow with no further work.
//
// Three deliberate narrowings, each of which is the difference between a card
// and noise:
//   - Single-file reads only (download / get metadata). A listing that returns
//     fifty files is a search result, not a hand-off, and fifty cards would bury
//     the reply the person asked for.
//   - Interactive turns only — the call carries a `threadId`. An autonomous
//     run has no chat to card into; its artifacts reach people through the
//     channel workers, which read the same rows.
//   - Connectors whose response carries the file's own identity (`id`, `name`,
//     `mimeType`) at the top of `data`. That shape is read from the vendor's
//     published output schema for the tools listed below, never guessed; a
//     connector whose shape has not been read is not carded, because a card
//     with the wrong name is worse than a link.
//
// Registration never fails the read: a read that succeeded is never failed by
// bookkeeping, and a card that fails to appear degrades to exactly what the
// person got before this existed — the link in the reply. What the gateway
// does wait for, briefly, is the platform's answer to one question — was a
// card appended? — because that answer is the only thing the model may be
// told about the card (see hostNoteForCardedFile).

import { logger } from '../infrastructure/logging';
import { catalogTypeFor } from '../connectors/tool-schema-cache';
import { getManagedSecret } from '../infrastructure/secret-store';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { fileCardHostNote } from './file-card-note';

/** Per connector type: the single-file read tools whose `data` carries
 *  `id` / `name` / `mimeType` at the top level (vendor output schemas, read
 *  2026-09-17), and how to build the view URL from the file id when the
 *  response does not carry one. */
const CARDED_READS: Record<string, { tools: ReadonlySet<string>; viewUrl: (id: string) => string }> = {
  google_drive: {
    tools: new Set(['download_file', 'get_file_metadata']),
    viewUrl: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
  },
};

/** The platform's document output types, by the file's MIME type. Anything
 *  the platform cannot name precisely is `binary`, which the card still
 *  renders with the filename — the name is the thing the person needs. */
export function outputTypeForMime(mimeType: string | undefined): string {
  switch ((mimeType ?? '').toLowerCase()) {
    // A native Google Doc is `gdoc`, the sibling of `gslides`: the platform
    // names a card `${baseName}_v${n}.${ext}` and gives a Google-native type
    // no extension, so `docx` here would card a Google Doc as `Report_v1.docx`
    // beside a URL that opens a Google Doc.
    case 'application/vnd.google-apps.document':
      return 'gdoc';
    case 'application/vnd.google-apps.presentation':
      return 'gslides';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'binary';
  }
}

export interface FoundFile {
  connectorFileId: string;
  name: string;
  outputType: string;
  webViewUrl: string;
}

/**
 * The file a successful read handed back, or null when this call is not one
 * that cards. Pure: reads the catalog type, the tool name and the result data,
 * and nothing else.
 */
export function foundFileFrom(args: {
  connector: string;
  actionType: string;
  result: unknown;
}): FoundFile | null {
  const family = CARDED_READS[catalogTypeFor(args.connector)];
  if (!family || !family.tools.has(args.actionType)) return null;

  const data = (args.result as { data?: unknown } | null)?.data ?? args.result;
  if (!data || typeof data !== 'object') return null;
  const d = data as { id?: unknown; name?: unknown; mimeType?: unknown; webViewLink?: unknown };
  if (typeof d.id !== 'string' || !d.id || typeof d.name !== 'string' || !d.name) return null;

  return {
    connectorFileId: d.id,
    name: d.name,
    outputType: outputTypeForMime(typeof d.mimeType === 'string' ? d.mimeType : undefined),
    webViewUrl: typeof d.webViewLink === 'string' && d.webViewLink ? d.webViewLink : family.viewUrl(d.id),
  };
}

/** What the platform answered about the card. `cardAppended` is true only
 *  when the route said the `file_output` message was inserted — a 201 with a
 *  file id is not that: the route appends the card in a catch that logs and
 *  continues. */
export interface FoundFileRegistration {
  cardAppended: boolean;
}

/** The registration call, injected so the gateway module owns no HTTP client
 *  of its own and a test can assert what was registered without a server. */
export type RegisterFoundFile = (args: {
  tenantId: string;
  agentId: string;
  threadId: string;
  /** The chat turn the read ran in, stamped on the card so the turn's reply
   *  can be checked against it. Absent when the caller did not carry one. */
  turnId: string | undefined;
  connectorId: string;
  file: FoundFile;
}) => Promise<FoundFileRegistration>;

/** A found file whose registration is in flight. `cardAppended` never
 *  rejects: false on any failure, true only on the platform's word. */
export interface CardedFoundFile {
  file: FoundFile;
  cardAppended: Promise<boolean>;
}

/**
 * Card a found file for the interactive turn that found it. Never throws and
 * never fails the read — the read already answered. The registration is
 * started here and handed back as a promise, so the caller can wait for the
 * platform's answer with a bound of its own (hostNoteForCardedFile) rather
 * than on the hot path.
 */
export function cardFoundFile(args: {
  tenantId: string;
  agentId: string;
  threadId: string | undefined;
  turnId: string | undefined;
  connector: string;
  connectorId: string | undefined;
  actionType: string;
  result: unknown;
  register: RegisterFoundFile;
}): CardedFoundFile | null {
  if (!args.threadId || !args.connectorId) return null;
  const file = foundFileFrom(args);
  if (!file) return null;

  const { tenantId, agentId, threadId, turnId, connectorId } = args;
  const cardAppended = args.register({ tenantId, agentId, threadId, turnId, connectorId, file }).then(
    (registration) => {
      logger.info(
        { tenantId, agentId, threadId, turnId, connector: args.connector, toolName: args.actionType, connectorFileId: file.connectorFileId, cardAppended: registration.cardAppended, event: 'found_file_carded' },
        registration.cardAppended
          ? 'a found file was registered as a card for the turn that found it'
          : 'a found file was registered, and the platform appended no card for it',
      );
      return registration.cardAppended;
    },
    (err: unknown) => {
      logger.warn(
        { tenantId, threadId, toolName: args.actionType, err: (err as Error).message },
        'found file could not be registered as a card; the reply keeps its link',
      );
      return false;
    },
  );
  return { file, cardAppended };
}

/** How long the gateway waits for the platform to say whether a card was
 *  appended before it stops waiting and tells the model nothing. The read
 *  already answered; this bounds what a slow registration can cost it. */
const CARD_APPENDED_WAIT_MS = 1_500;

/**
 * The host note for the model, or nothing.
 *
 * Nothing on `generatedFileId` alone, nothing on a timeout, nothing on a
 * failure: the note is appended only when the platform answered
 * `cardAppended: true` within the bound. The model then repeats a fact the
 * host asserted instead of inferring a card from a tool's success.
 */
export async function hostNoteForCardedFile(
  carded: CardedFoundFile | null,
  boundMs: number = CARD_APPENDED_WAIT_MS,
): Promise<string | undefined> {
  if (!carded) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
    timer.unref?.();
  });
  try {
    const appended = await Promise.race([carded.cardAppended, timedOut]);
    return appended ? fileCardHostNote(carded.file.name) : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The production transport: the same connector-native registration door the
 * document tools use for a deck they wrote into Drive. A found file and a
 * made file are the same row from here on.
 */
export const registerFoundFileWithPlatform: RegisterFoundFile = async ({ tenantId, agentId, threadId, turnId, connectorId, file }) => {
  const pbUrl = (process.env.PLATFORM_BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!pbUrl) throw new Error('PLATFORM_BACKEND_URL is not set');
  // Two agent id spaces (ADR-039): the gateway holds the RUNTIME id, and
  // `generated_files.agent_id` is a foreign key to platform-backend's
  // `internal_agents.id`. Translated here, at the one boundary that crosses
  // into the other database — the runtime id matches zero rows there and the
  // registration answers 500.
  const internalAgentId = await resolveInternalAgentId(tenantId, agentId, 'found-file-cards');
  if (!internalAgentId) throw new Error(`no internal agent id maps to runtime agent ${agentId}`);
  const resp = await fetch(`${pbUrl}/api/generated-files/register-connector-native`, {
    method: 'POST',
    headers: {
      'X-Service-Auth': getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agentId: internalAgentId,
      tenantId,
      baseName: file.name,
      outputType: file.outputType,
      conversationId: threadId,
      connectorId,
      connectorFileId: file.connectorFileId,
      webViewUrl: file.webViewUrl,
      ...(turnId ? { turnId } : {}),
    }),
  });
  if (!resp.ok) {
    // At error, with what the platform said: a refused registration is a
    // missing card that nobody is looking for, and the next break in this
    // door has to show in the error stream rather than as an absence.
    const body = await resp.text().catch(() => '');
    logger.error(
      { event: 'connector_native_registration_failed', status: resp.status, body: body.slice(0, 2000), tenantId, threadId, outputType: file.outputType, connectorId },
      'register-connector-native refused a found file; the reply keeps its link and gets no card',
    );
    throw new Error(`register-connector-native answered ${resp.status}`);
  }
  const data = (await resp.json().catch(() => ({}))) as { cardAppended?: boolean };
  return { cardAppended: data.cardAppended === true };
};
