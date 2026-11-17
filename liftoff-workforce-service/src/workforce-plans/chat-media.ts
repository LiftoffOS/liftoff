// The Chief AI Officer's half of inbound media.
//
// Everything about storing, serving and deciding lives in the control plane:
// it owns the bucket, the allow-list, the download route, and the model
// capability registry that answers whether a model can see a picture at all.
// This service owns one thing the control plane cannot reach — its own
// messages table, in its own database — so two things have to cross the
// boundary by HTTP.
//
//   1. CLAIMING. An upload is provisional until a sent message references it,
//      and unclaimed uploads are swept after a day. The other three chat
//      surfaces claim in-process at the moment they persist the message; this
//      one cannot, because the moment its message is written is not a moment
//      the control plane can see.
//   2. READING. A vendor takes an image as base64 in the request body and will
//      not fetch a link out of a private bucket, so the bytes have to come
//      here rather than a URL going out.

import { loadConfig } from '../infrastructure/config.js';
import { log } from '../infrastructure/logging.js';
import type { MediaRef, SendableModalities } from '@liftoffos/chat-attachments';

function platformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

function serviceToken(): string {
  return process.env['WORKFORCE_SERVICE_TOKEN'] ?? '';
}

/**
 * Tell the control plane that a sent message carries these uploads.
 *
 * Best effort, deliberately. A claim that fails costs the person their picture
 * a day from now, when the retention sweep runs; failing their message over it
 * would cost them the picture immediately and the conversation with it.
 */
export async function claimInboundMedia(
  tenantId: string,
  threadId: string,
  mediaIds: readonly string[],
): Promise<void> {
  if (mediaIds.length === 0) return;
  try {
    const res = await fetch(`${platformBackendUrl()}/api/chat-media/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-auth': serviceToken() },
      body: JSON.stringify({ tenantId, threadId, surface: 'team_plan', mediaIds }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, threadId, count: mediaIds.length },
        'CAIO: could not claim inbound media; the sweep may reclaim it',
      );
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, threadId },
      'CAIO: claiming inbound media threw; continuing',
    );
  }
}

/**
 * Read the bytes behind the media this turn may show the model.
 *
 * Returns fewer items than it was given when something cannot be read — a
 * swept object, a row that does not exist. That is not an error path: the
 * control plane has already told the model in words which media it will not be
 * shown, and an unreadable one simply joins that list. Losing the whole turn
 * over a missing picture would be the wrong trade.
 */
export async function loadTurnImages(
  tenantId: string,
  media: readonly MediaRef[],
): Promise<Array<{ mimeType: string; dataBase64: string; alt?: string }>> {
  const out: Array<{ mimeType: string; dataBase64: string; alt?: string }> = [];
  for (const ref of media) {
    try {
      const url =
        `${platformBackendUrl()}/api/generated-files/${encodeURIComponent(ref.mediaId)}/content`
        + `?tenantId=${encodeURIComponent(tenantId)}`;
      const res = await fetch(url, {
        headers: { 'x-service-auth': serviceToken() },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        log.warn({ status: res.status, mediaId: ref.mediaId }, 'CAIO: could not read stored media');
        continue;
      }
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim();
      if (!mimeType) continue;
      out.push({
        mimeType,
        dataBase64: Buffer.from(await res.arrayBuffer()).toString('base64'),
        ...(ref.alt ? { alt: ref.alt } : {}),
      });
    } catch (err) {
      log.warn({ err: (err as Error).message, mediaId: ref.mediaId }, 'CAIO: media read threw');
    }
  }
  return out;
}

/**
 * What the model this turn will run on can actually be shown.
 *
 * Two questions, both answered on the other side of the relay: whether the
 * MODEL takes a still or a video, and whether the PROVIDER the request resolves
 * to can express one. This service picks a TIER, not a model, and the tier is
 * resolved over there — so it asks rather than guessing.
 *
 * Answers "neither" on any failure. That costs an honest sentence in the prompt
 * saying the media cannot be read; the opposite default costs a vendor error on
 * the person's turn.
 */
export async function sendableModalities(purpose: string): Promise<SendableModalities> {
  try {
    const res = await fetch(`${platformBackendUrl()}/api/internal/llm/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-auth': serviceToken() },
      body: JSON.stringify({ purpose }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { image: false, video: false };
    const body = (await res.json()) as { sendable?: SendableModalities };
    return body.sendable ?? { image: false, video: false };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'CAIO: modality lookup failed; assuming none');
    return { image: false, video: false };
  }
}
