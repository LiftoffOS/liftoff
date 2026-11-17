// Whether the model about to run this turn can actually look at a picture.
//
// This is the first consumer `models.capabilities` has ever had. The column has
// existed since migration 001 and was read by nothing, which was survivable
// while every capability in it was descriptive. Vision is not descriptive: a
// model without it does not give a worse answer when handed an image block, it
// returns a 400, and the failure lands on somebody who has just attached a
// screenshot and asked a question about it.
//
// The rule in one line: an image block is sent ONLY to a model the registry
// says can see one. Everything else is told, in words, that there is a picture
// it cannot look at. Never an error, and never a silent drop — a silent drop is
// the failure this whole feature exists to remove, because the model then
// answers from the file name and nothing distinguishes that from having looked.

import {
  MAX_IMAGES_PER_TURN,
  partitionMediaForModel,
  type MediaRef,
  type SendableModalities,
} from '../chat-attachments';
import { withAdminScope } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { readMediaBytes } from '../media/read';
import type { LLMImageBlock } from './types';

/** The capability strings, spelled once. Written by migrations 394 and 395.
 *  `sync-model-pricing` reconciles both from the OpenRouter catalogue and must
 *  keep spelling them the same way. */
export const VISION_CAPABILITY = 'vision';
export const VIDEO_CAPABILITY = 'video';

/**
 * What each ENGINE can express, as opposed to what a model can understand.
 *
 * Two different questions, and both have to be yes. `models.capabilities` says
 * a Gemini model can watch a video; this says whether the code that will
 * actually run the turn can put one in the request. Gemini's `inlineData` is a
 * generic blob and carries either; Anthropic's and OpenAI's image blocks carry
 * only images; the three self-managing engines take a text prompt and carry
 * neither.
 *
 * Keyed by the PROVIDER the request resolves to, because that is what decides
 * which builder runs. An unknown provider carries nothing, which costs an
 * honest sentence rather than a vendor error.
 */
const PROVIDER_CARRIES: Record<string, { image: boolean; video: boolean }> = {
  anthropic: { image: true, video: false },
  openai: { image: true, video: false },
  // OpenRouter rides the OpenAI wire, so it can express an image part and has
  // no video part to express — regardless of what the model behind it accepts.
  openrouter: { image: true, video: false },
  google: { image: true, video: true },
};

// The registry changes on the order of once a month, and a chat turn asks this
// question on every message. Cached with a short TTL so a newly-marked model
// takes effect within a minute rather than needing a deploy, and so a registry
// outage does not cost every turn a query.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; models: { vision: Set<string>; video: Set<string> } } | null = null;

async function loadModalityModels(): Promise<{ vision: Set<string>; video: Set<string> }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  // `models` is a global catalog with no tenant_id — the same shape and the
  // same rationale as the other cross-tenant registry reads.
  // Both modalities in ONE query. Two queries would be two cache entries and two
  // chances for a model to be considered vision-capable and video-capable at
  // different instants.
  const result = await withAdminScope(
    { caller: 'llm.vision.loadModalityModels', reason: 'read the global model capability catalog' },
    (client) =>
      client.query(
        `SELECT model_id,
                capabilities @> $1::jsonb AS has_vision,
                capabilities @> $2::jsonb AS has_video
           FROM models
          WHERE status = 'approved'
            AND (capabilities @> $1::jsonb OR capabilities @> $2::jsonb)`,
        [JSON.stringify([VISION_CAPABILITY]), JSON.stringify([VIDEO_CAPABILITY])],
      ),
  );
  const rows = result.rows as Array<{ model_id: string; has_vision: boolean; has_video: boolean }>;
  const models = {
    vision: new Set(rows.filter((r) => r.has_vision).map((r) => r.model_id)),
    video: new Set(rows.filter((r) => r.has_video).map((r) => r.model_id)),
  };
  cache = { at: Date.now(), models };
  return models;
}

/** Drop the cache. Exported for the registry writes that change what it holds. */
export function resetVisionCache(): void {
  cache = null;
}

/**
 * What this model is recorded as able to take, both modalities at once.
 *
 * An UNKNOWN model answers no to everything, which is the safe direction and
 * the only safe direction: a capable model somebody forgot to mark gives the
 * person a clear sentence saying the media cannot be read, while a model marked
 * by accident gives them a vendor error.
 */
export async function modelModalities(
  modelId: string | undefined,
): Promise<{ image: boolean; video: boolean }> {
  if (!modelId) return { image: false, video: false };
  try {
    const models = await loadModalityModels();
    return { image: models.vision.has(modelId), video: models.video.has(modelId) };
  } catch (err) {
    // A registry read that failed knows nothing. Answering "yes" on an outage
    // would turn a database blip into a 400 from the vendor on every turn that
    // carries media.
    log.warn({ error: (err as Error).message, modelId }, 'vision: capability lookup failed');
    return { image: false, video: false };
  }
}

/**
 * What a turn may actually send: the model's capability AND the engine's.
 *
 * This is the whole of the gate, and it is deliberately an intersection. A
 * Gemini model on a provider whose builder has no video part, and a video-
 * capable provider running a text-only model, both have to end in the same
 * place — described in words.
 */
export async function sendableModalities(
  modelId: string | undefined,
  provider: string | undefined,
): Promise<SendableModalities> {
  const model = await modelModalities(modelId);
  const engine = (provider ? PROVIDER_CARRIES[provider] : undefined)
    ?? { image: false, video: false };
  return { image: model.image && engine.image, video: model.video && engine.video };
}

/**
 * Record that a turn is about to show a model content NOTHING screened.
 *
 * The injection detector is text-only — `screenPersistedContent(kind, content:
 * string, ...)` — so a file name is inspected and the picture behind it is not.
 * Enabling vision therefore widens the untrusted-input surface to content no
 * existing control can see: instructions written INSIDE an image reach the
 * model exactly as the person who drew them wrote them.
 *
 * That is a real and accepted exposure, not a bug to be fixed here — no
 * detector in this estate reads pixels. What is not acceptable is for it to be
 * implied. This makes it explicit in the audit trail, on the same
 * `untrusted_inbound` vocabulary the rest of the platform already uses for
 * input that arrived from outside and was not vetted, so a forensic timeline
 * can answer "was this turn shown something nobody checked".
 */
export function noteUnscreenedMediaExposure(ctx: {
  tenantId: string;
  surface: string;
  threadId?: string;
  /** How many images this turn puts in front of the model. A COUNT rather than
   *  the blocks: one caller has fetched the bytes and one has only the refs
   *  (the runtime fetches on that path), and the fact being recorded is the
   *  same either way. */
  imageCount: number;
}): void {
  if (ctx.imageCount === 0) return;
  logAudit(
    'chat.untrusted_inbound_media',
    { tenantId: ctx.tenantId },
    {
      surface: ctx.surface,
      threadId: ctx.threadId ?? null,
      imageCount: ctx.imageCount,
      trustLevel: 'untrusted_inbound',
      // Said in the record itself, because a reader six months from now should
      // not have to know the detector's signature to interpret this row.
      note: 'Images were sent to a model. Injection screening is text-only and did not inspect them.',
    },
  );
}

export interface PreparedTurnMedia {
  /** Image blocks to attach to the user message. Empty when the model cannot
   *  see, when nothing was readable, or when there was no media. */
  images: LLMImageBlock[];
  /** Media the model is told about in words instead. Feed to composeTurnText. */
  described: MediaRef[];
}

/**
 * Turn one message's media into what the request actually carries.
 *
 * The whole vision decision for a surface, in one call: resolve the model's
 * capability, split the media, fetch the bytes for the half that can be seen,
 * and hand back the other half to be described. Every surface calls this rather
 * than reimplementing the split, because the two halves have to add up — a ref
 * that is neither sent nor described is a picture the person attached and
 * nobody ever mentioned again.
 *
 * A ref whose bytes cannot be read moves to `described`. That is not an error
 * path: the object may have been swept, or the row may belong to another
 * tenant, and in both cases the honest outcome is the same sentence a video
 * gets.
 */
export async function prepareTurnMedia(
  tenantId: string,
  media: readonly MediaRef[],
  modelId: string | undefined,
  /** Which provider will run the turn. Decides what the request can EXPRESS,
   *  which is a different question from what the model can understand. */
  provider: string | undefined,
  /** Which surface is asking, for the exposure record below. */
  audit?: { surface: string; threadId?: string },
): Promise<PreparedTurnMedia> {
  if (media.length === 0) return { images: [], described: [] };

  const sendable = await sendableModalities(modelId, provider);
  const { readable, described } = partitionMediaForModel(media, sendable);

  const images: LLMImageBlock[] = [];
  const unreadable: MediaRef[] = [];
  for (const ref of readable.slice(0, MAX_IMAGES_PER_TURN)) {
    const stored = await readMediaBytes(tenantId, ref.mediaId);
    if (!stored) {
      unreadable.push(ref);
      continue;
    }
    images.push({
      mimeType: stored.mimeType,
      dataBase64: stored.bytes.toString('base64'),
      ...(ref.alt ? { alt: ref.alt } : {}),
      // Carried for COSTING, not for the provider: a budget that cannot see an
      // image's size counts a screenshot as the length of its caption.
      ...(ref.width != null ? { width: ref.width } : {}),
      ...(ref.height != null ? { height: ref.height } : {}),
    });
  }

  if (audit) {
    noteUnscreenedMediaExposure({
      tenantId,
      surface: audit.surface,
      ...(audit.threadId ? { threadId: audit.threadId } : {}),
      imageCount: images.length,
    });
  }

  return { images, described: [...described, ...unreadable] };
}
