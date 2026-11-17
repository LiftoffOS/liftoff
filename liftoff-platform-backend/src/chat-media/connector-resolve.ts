// Turning a file somebody PICKED from a cloud drive into something the turn can
// actually carry.
//
// The four cloud buttons in the composer have never delivered file content, for
// any file type. They attach a name, a connector id and an external id, and the
// model is handed the name alone — so a person who attached "Q3 revenue.xlsx"
// and asked what the numbers say got an answer built from the filename. For a
// picture that failure is total: there is no text at all behind the name.
//
// This module resolves each pick into one of exactly three outcomes, and the
// third is why it exists:
//
//   text  — extracted and inlined, exactly as an upload from the computer is
//   media — bytes fetched, stored, and referenced like any other media
//   refusal — with a reason the person can read
//
// A refusal is a RESULT, not an error. Some of these files genuinely cannot be
// fetched, and the honest answer is to say which and why. Silently attaching a
// name instead is what this replaces.

import { log } from '../infrastructure/logging';
import {
  MAX_ATTACHMENT_CONTENT_CHARS,
  MAX_MEDIA_BYTES,
  type ChatAttachment,
} from '../chat-attachments';
import {
  ConnectorFileTooLargeError,
  extractConnectorFileText,
  fetchConnectorFileBytes,
} from '../knowledge/service';
import { COMPOSIO_MANAGED_CONNECTOR_TYPES } from '../internal-api/platform-tools-router';
import { canonicalMediaMimeType } from '../generated-files/store';
import {
  MediaContentMismatchError,
  storeInboundMedia,
  type InboundSurface,
} from '../media/inbound';

export interface ConnectorPick {
  externalId: string;
  name: string;
  /** The picker's own kind ('file' | 'folder' | 'document' | ...). */
  contentType?: string;
  /** The provider's MIME for the file, when the picker knew one. */
  mimeType?: string;
  sourceUrl?: string;
}

export type ConnectorResolveResult =
  | { externalId: string; ok: true; attachment: ChatAttachment }
  | { externalId: string; ok: false; name: string; reason: string };

export interface ResolveConnectorAttachmentsInput {
  tenantId: string;
  accountId: string;
  surface: InboundSurface | null;
  threadId: string | null;
  connectorId: string;
  connectorType: string;
  items: readonly ConnectorPick[];
}

/** Extensions that mean "this is media", for the pickers that hand back no
 *  MIME at all. Keyed to the store's allow-list rather than to a general
 *  image/video list: a `.heic` is media in the everyday sense and is not
 *  something this platform can store, so it must fall through to the text
 *  branch and be refused there for the right reason. */
const MEDIA_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

/** The media type this pick is, or null when it is not media we store. */
function mediaTypeOf(pick: ConnectorPick): string | null {
  const declared = canonicalMediaMimeType(pick.mimeType);
  if (declared) return declared;
  const ext = pick.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return (ext && MEDIA_EXTENSIONS[ext]) || null;
}

/**
 * Whether this connector can serve raw bytes at all.
 *
 * Composio-managed connectors cannot, and this is recorded in the extraction
 * path it shares: Composio signs the request server-side and returns a DECODED
 * body, so text is the only shape that survives the proxy. Asking one for a PNG
 * gets a response that looks like a success and is not the file.
 *
 * That covers three of the four cloud pickers — Google Drive, OneDrive and
 * Dropbox are all composio-managed — so for those, media is refused rather than
 * corrupted. Storing a decoded body as an image would produce a broken-image
 * box in the thread and a model confidently answering about it, which is worse
 * than a sentence saying the file could not be fetched.
 */
function canServeBinary(connectorType: string): boolean {
  return !COMPOSIO_MANAGED_CONNECTOR_TYPES.has(connectorType);
}

export async function resolveConnectorAttachments(
  input: ResolveConnectorAttachmentsInput,
): Promise<ConnectorResolveResult[]> {
  const addedAt = new Date().toISOString();
  const results: ConnectorResolveResult[] = [];

  for (const pick of input.items) {
    const refuse = (reason: string): void => {
      results.push({ externalId: pick.externalId, ok: false, name: pick.name, reason });
    };

    // A folder is not a file. The picker allows one to be ticked because other
    // callers (knowledge import, connector bindings) mean something by it;
    // a chat attachment does not.
    if (pick.contentType === 'folder' || pick.contentType === 'collection') {
      refuse('Folders cannot be attached to a message. Pick the files inside it.');
      continue;
    }

    const mediaType = mediaTypeOf(pick);

    try {
      if (mediaType) {
        if (!canServeBinary(input.connectorType)) {
          refuse(
            `Images and clips cannot be fetched from ${input.connectorType.replace(/_/g, ' ')} yet — that connection can only return text. Download the file and attach it from your computer.`,
          );
          continue;
        }

        const { buffer, contentType } = await fetchConnectorFileBytes(
          {
            tenantId: input.tenantId,
            connectorId: input.connectorId,
            connectorType: input.connectorType,
            externalId: pick.externalId,
            fileName: pick.name,
            mimeType: pick.mimeType,
          },
          { maxBytes: MAX_MEDIA_BYTES },
        );

        // What the response says beats what the picker guessed — the same
        // precedence the extraction path uses, and for the same reason: the
        // stored MIME is the file's type at the provider, which diverges from
        // the shape it actually arrives in.
        const effectiveType =
          canonicalMediaMimeType(contentType) ?? mediaType;

        const media = await storeInboundMedia({
          tenantId: input.tenantId,
          accountId: input.accountId,
          surface: input.surface,
          threadId: input.threadId,
          bytes: buffer,
          mimeType: effectiveType,
          filename: pick.name,
        });

        results.push({
          externalId: pick.externalId,
          ok: true,
          attachment: { kind: 'media', name: pick.name, media, addedAt },
        });
        continue;
      }

      // Not media: the general case the cloud buttons have never handled.
      const text = await extractConnectorFileText({
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        connectorType: input.connectorType,
        externalId: pick.externalId,
        contentType: pick.contentType,
        mimeType: pick.mimeType,
        fileName: pick.name,
      });

      if (!text.trim()) {
        // Zero characters is a failed read, not an empty document — the same
        // rule knowledge extraction learned the hard way. Saying so is the
        // whole point of this route.
        refuse('Nothing could be read from this file. It may be an unsupported format or empty.');
        continue;
      }

      results.push({
        externalId: pick.externalId,
        ok: true,
        attachment: {
          kind: 'upload',
          name: pick.name,
          content: text.slice(0, MAX_ATTACHMENT_CONTENT_CHARS),
          addedAt,
        },
      });
    } catch (err) {
      if (err instanceof ConnectorFileTooLargeError) {
        refuse(err.message);
        continue;
      }
      if (err instanceof MediaContentMismatchError) {
        refuse('The file that came back was not a valid image or clip.');
        continue;
      }
      log.warn(
        {
          error: (err as Error).message,
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          connectorType: input.connectorType,
        },
        'chat-media: could not resolve a connector pick',
      );
      refuse('This file could not be fetched from the connected account.');
    }
  }

  return results;
}
