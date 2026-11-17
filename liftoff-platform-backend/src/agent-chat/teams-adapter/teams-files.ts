// Getting a voice memo out of Teams.
//
// Inbound only, and that is the whole story on this platform. Teams supports no
// Audio card, and a bot sending a real file has to write it into the customer's
// own OneDrive or SharePoint through Graph — their quota, their retention, their
// eDiscovery — for something that still renders as an attachment rather than a
// voice message. So Teams listens and answers in writing.
//
// An inbound attachment carries a `contentUrl` we can fetch. Some are public
// blob URLs; a file the user uploaded arrives as
// `application/vnd.microsoft.teams.file.download.info` with a `downloadUrl`
// inside its content that needs no auth of ours.

import { log } from '../../infrastructure/logging';

interface TeamsAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: { downloadUrl?: string; fileType?: string } | unknown;
}

const AUDIO_MIME = /^audio\//i;
/** Extensions Teams reports for a recorded clip when the mime type is generic. */
const AUDIO_EXTENSION = /\.(mp3|m4a|mp4|wav|ogg|webm|aac)$/i;

/** Teams' wrapper for a file the user uploaded, rather than an inline blob. */
const DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';

/** Biggest memo worth fetching, matching the shared transcription bound. */
const MAX_MEMO_BYTES = 8 * 1024 * 1024;

export interface TeamsAudioRef {
  url: string;
  mimeType: string;
}

/**
 * The audio attachment on an activity, if there is one.
 *
 * Two shapes, because Teams has two: an inline attachment whose contentType is
 * the audio type, and a download-info wrapper whose real link sits in `content`.
 */
export function findTeamsAudio(attachments: unknown): TeamsAudioRef | null {
  if (!Array.isArray(attachments)) return null;

  for (const raw of attachments) {
    const attachment = raw as TeamsAttachment;
    const contentType = attachment?.contentType ?? '';

    if (AUDIO_MIME.test(contentType) && attachment.contentUrl) {
      return { url: attachment.contentUrl, mimeType: contentType };
    }

    if (contentType === DOWNLOAD_INFO) {
      const content = attachment.content as { downloadUrl?: string; fileType?: string } | undefined;
      const url = content?.downloadUrl;
      const name = attachment.name ?? '';
      const fileType = content?.fileType ?? '';
      if (url && (AUDIO_EXTENSION.test(name) || AUDIO_EXTENSION.test(`.${fileType}`))) {
        // Teams does not say the mime type here, and the transcriber decodes the
        // container from its own headers anyway — so name it plausibly and let
        // the decoder be the authority.
        return { url, mimeType: 'audio/mp4' };
      }
    }
  }
  return null;
}

/**
 * Fetch the bytes.
 *
 * Returns null rather than throwing: a memo we cannot read is a message we
 * cannot answer, and that belongs in a log, not thrown into a bot turn.
 */
export async function downloadTeamsAudio(
  ref: TeamsAudioRef,
): Promise<{ audio: Buffer; mimeType: string } | null> {
  try {
    const response = await fetch(ref.url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      log.warn({ status: response.status }, 'Teams audio download refused');
      return null;
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_MEMO_BYTES) {
      log.warn({ bytes: declared }, 'Teams audio too large to transcribe');
      return null;
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_MEMO_BYTES) return null;

    // Prefer what the server says it sent over what the attachment claimed.
    const served = response.headers.get('content-type') ?? '';
    const mimeType = AUDIO_MIME.test(served) ? served.split(';')[0] as string : ref.mimeType;
    return { audio, mimeType };
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Teams audio download failed');
    return null;
  }
}
