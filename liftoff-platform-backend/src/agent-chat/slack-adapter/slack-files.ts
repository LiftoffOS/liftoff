// Moving audio in and out of Slack.
//
// Two shapes, both awkward enough to keep away from the message handlers.
//
// DOWNLOAD is not a Slack API call. A file's `url_private_download` is an
// ordinary HTTPS URL that only answers with the bot token in an Authorization
// header, and answers 200 with an HTML login page if the token lacks
// `files:read` — so the content type has to be checked rather than trusted.
//
// UPLOAD is three calls. Slack retired the one-shot `files.upload`: you ask for
// a URL, POST the bytes to it, then tell Slack to complete and share it. Each
// step can fail on its own, and a half-finished upload leaves a file nobody can
// see, so the whole thing reports failure rather than a partial success.
//
// Both need scopes the app did not have before `files:read` and `files:write`
// were added, and Slack does not extend an existing token with new scopes. Until
// a workspace reinstalls, these fail with `missing_scope` — which is exactly why
// every caller treats audio as optional.

import { log } from '../../infrastructure/logging';
import { slackApiFetch } from './slack-api';

/** A file Slack told us about on an incoming message. */
export interface SlackFileRef {
  id?: string;
  mimetype?: string;
  /** Slack sets 'slack_audio' on a recorded voice memo, whatever the mimetype. */
  subtype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/** Slack's own voice memos, plus anything else a person might record. */
const AUDIO_MIME = /^audio\//i;

/** What Slack calls a recorded voice memo, regardless of its container. */
const SLACK_VOICE_SUBTYPE = 'slack_audio';

/**
 * The audio file on a message, if there is one.
 *
 * A Slack voice memo arrives as a file with no `text` at all, which is why the
 * event handler cannot simply require text.
 */
export function findAudioFile(files: unknown): SlackFileRef | null {
  if (!Array.isArray(files)) return null;
  for (const raw of files) {
    const file = raw as SlackFileRef;
    // Slack labels a voice memo's own mimetype audio/*, but its MP4 container is
    // served as video/mp4 — so the explicit subtype is the more reliable signal
    // of the two, and either one is enough.
    if (file?.subtype === SLACK_VOICE_SUBTYPE) return file;
    if (typeof file?.mimetype === 'string' && AUDIO_MIME.test(file.mimetype)) return file;
  }
  return null;
}

/**
 * Fetch a file's bytes with the bot token.
 *
 * Returns null rather than throwing: a memo we cannot read is a message we
 * cannot answer, and that is worth a log, not an exception into a webhook.
 */
export async function downloadSlackFile(
  file: SlackFileRef,
  botToken: string,
): Promise<{ audio: Buffer; mimeType: string } | null> {
  const url = file.url_private_download ?? file.url_private;
  if (!url || !file.mimetype) return null;

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      log.warn({ status: response.status, fileId: file.id }, 'Slack file download refused');
      return null;
    }

    // Slack answers 200 with an HTML sign-in page when the token cannot read
    // files, so the status alone does not mean we got the file. That page is
    // the ONLY thing worth rejecting here.
    //
    // Requiring audio/* was wrong and rejected real memos: a Slack voice memo is
    // an MP4 container, and Slack serves it as `video/mp4` even though there is
    // no video in it. The container the transcriber decodes comes from the
    // event's own mimetype, not from this header.
    const contentType = response.headers.get('content-type') ?? '';
    if (/^text\/html/i.test(contentType)) {
      log.warn(
        { contentType, fileId: file.id },
        'Slack served a sign-in page instead of the file — the bot token is missing files:read',
      );
      return null;
    }

    return { audio: Buffer.from(await response.arrayBuffer()), mimeType: file.mimetype };
  } catch (err) {
    log.error({ error: (err as Error).message, fileId: file.id }, 'Slack file download failed');
    return null;
  }
}

/**
 * Put a file into a channel, alongside whatever was already said there.
 *
 * Returns false on any failure. The caller has already delivered the written
 * reply, so a false here costs a listener their audio and nobody their answer.
 */
export async function uploadSlackAudio(opts: {
  botToken: string;
  channel: string;
  threadTs?: string | undefined;
  filename: string;
  audio: Buffer;
  title: string;
}): Promise<boolean> {
  try {
    // 1. Ask where to put it.
    const reserved = await slackApiFetch('files.getUploadURLExternal', {
      authToken: opts.botToken,
      body: {
        kind: 'form',
        value: { filename: opts.filename, length: String(opts.audio.length) },
      },
    });
    // Flat, not nested: SlackApiResponse spreads the payload at the top level.
    // Reading a `.data` wrapper that does not exist made this always undefined,
    // so a successful reservation was thrown away as a failure.
    const uploadUrl = typeof reserved.upload_url === 'string' ? reserved.upload_url : null;
    const fileId = typeof reserved.file_id === 'string' ? reserved.file_id : null;
    if (!reserved.ok || !uploadUrl || !fileId) {
      log.warn(
        // The whole envelope, because `error` is absent when the call succeeded
        // and we simply failed to read it — which is exactly what happened.
        { ok: reserved.ok, error: reserved.error, keys: Object.keys(reserved) },
        'Slack would not reserve an upload URL for voice',
      );
      return false;
    }

    // 2. Send the bytes. This one is not a Slack API call and has no envelope.
    const put = await fetch(uploadUrl, {
      method: 'POST',
      body: new Uint8Array(opts.audio),
      signal: AbortSignal.timeout(30_000),
    });
    if (!put.ok) {
      log.warn({ status: put.status }, 'Slack rejected the voice upload body');
      return false;
    }

    // 3. Share it. Until this call, the file exists and nobody can see it.
    const completed = await slackApiFetch('files.completeUploadExternal', {
      authToken: opts.botToken,
      body: {
        kind: 'json',
        value: {
          files: [{ id: fileId, title: opts.title }],
          channel_id: opts.channel,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        },
      },
    });
    if (!completed.ok) {
      log.warn(
        { ok: completed.ok, error: completed.error, keys: Object.keys(completed) },
        'Slack would not share the uploaded voice file',
      );
      return false;
    }
    log.info(
      { channel: opts.channel, bytes: opts.audio.length, fileId },
      'Spoken reply posted to Slack',
    );
    return true;
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Slack voice upload failed');
    return false;
  }
}
