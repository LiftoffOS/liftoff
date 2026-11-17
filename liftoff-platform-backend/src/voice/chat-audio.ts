// Voice on a chat platform: a memo in, a spoken reply out.
//
// Slack and Teams differ in how they deliver and accept audio, and not at all in
// what should happen to it. So the transcribing, the synthesising, the length
// cap and the ledger rows live here once, and each adapter only has to know how
// its own platform moves bytes.
//
// TWO RULES SHAPE EVERYTHING BELOW.
//
// Audio is additive. The written reply goes out exactly as it does today; the
// spoken one accompanies it. A vendor outage, a missing OAuth scope, a workspace
// that has not re-consented — none of those may cost somebody their answer, so
// every function here returns null on failure rather than throwing into a
// delivery path.
//
// Silence still bills. A memo that turns out to be nothing was still listened to,
// and the vendor charged for listening. The ledger row is written from the
// duration either way, exactly as the browser path does it.

import { log } from '../infrastructure/logging';
import { resolveSttProvider, resolveTtsProvider, vendorForLane } from './registry';
import { recordDictationCost, recordSynthesisCost, type DictationSurface } from './cost';
import { toSpokenFile } from './spoken-text';
import { voiceFor } from './voice-identity';
import type { VoiceUsage } from './types';

/** Chat platforms that carry voice. Narrower than DictationSurface on purpose. */
export type ChatVoiceSurface = Extract<DictationSurface, 'slack' | 'teams'>;

/**
 * Audio the platform is willing to hand us.
 *
 * Slack voice memos are MP4/AAC and are sometimes labelled `video/mp4`, because
 * the container is an MP4 whether or not there is video in it. Cloud STT decodes
 * from the file's own headers, so this list refuses obviously-wrong uploads
 * early rather than steering the decoder.
 */
const TRANSCRIBABLE = /^(audio\/|video\/mp4$|application\/octet-stream$)/i;

/**
 * Biggest memo worth transcribing.
 *
 * Cloud STT's synchronous path tops out around a minute of audio, and anything
 * approaching that is not a chat message. Refusing early keeps a huge upload
 * from becoming a billed failure.
 */
const MAX_MEMO_BYTES = 8 * 1024 * 1024;

export interface TranscribeMemoInput {
  tenantId: string;
  surface: ChatVoiceSurface;
  audio: Buffer;
  mimeType: string;
  /** Stable per delivery, so a retried webhook cannot bill twice. */
  sourceId: string;
}

export interface TranscribedMemo {
  /** Empty when the recording had no words in it. Silence is not a failure. */
  transcript: string;
  usage: VoiceUsage;
  provider: string;
}

/**
 * Turn a voice memo into the text of a message.
 *
 * DOES NOT BILL. The agent this belongs to is not known yet on every surface —
 * on Slack the transcript is what decides which teammate is being addressed, so
 * routing cannot happen until after this runs. Billing here meant every memo
 * was attributed to no agent, and `classifyChargeability` will not honour a
 * customer purpose without one: every Slack memo was silently absorbed by
 * Liftoff instead of charged. The caller bills with `recordMemoCost` once it
 * knows who the message was for.
 *
 * Returns null only when nothing was transcribed at all — an unsupported file or
 * a failure. A recording with no words returns an empty transcript WITH usage,
 * because listening was billed either way.
 */
export async function transcribeVoiceMemo(
  input: TranscribeMemoInput,
): Promise<TranscribedMemo | null> {
  if (!TRANSCRIBABLE.test(input.mimeType)) return null;
  if (input.audio.length === 0 || input.audio.length > MAX_MEMO_BYTES) {
    log.warn(
      { surface: input.surface, bytes: input.audio.length, mimeType: input.mimeType },
      'Voice memo refused before transcription',
    );
    return null;
  }

  try {
    const provider = resolveSttProvider('dictation_stt', input.tenantId);
    const { transcript, usage } = await provider.recognizeFile({
      audio: input.audio,
      mimeType: input.mimeType,
      language: undefined,
    });

    // Logged on the way through, not only on failure. Success was silent, which
    // made "it worked" and "it never ran" look identical from the outside.
    log.info(
      {
        surface: input.surface,
        chars: transcript.length,
        seconds: usage.quantity,
        provider: provider.key,
      },
      'Voice memo transcribed',
    );
    return { transcript, usage, provider: provider.key };
  } catch (err) {
    log.error(
      { error: (err as Error).message, surface: input.surface, tenantId: input.tenantId },
      'Voice memo could not be transcribed',
    );
    return null;
  }
}

/**
 * Bill a transcription, once the agent it belongs to is known.
 *
 * Called even when nothing was heard: listening was charged whether or not it
 * produced words, and skipping the row would under-bill and break reconciliation
 * against the vendor invoice. Called even when no agent could be resolved, where
 * it lands as platform overhead — which is correct, because there is nobody to
 * charge, and is NOT the same as the bug where an agent existed and was not
 * passed.
 */
export async function recordMemoCost(input: {
  tenantId: string;
  surface: ChatVoiceSurface;
  agentId: string | undefined;
  memo: TranscribedMemo;
  sourceId: string;
}): Promise<void> {
  await recordDictationCost({
    tenantId: input.tenantId,
    surface: input.surface,
    agentId: input.agentId,
    provider: input.memo.provider,
    usage: input.memo.usage,
    sourceId: `voice-stt:${input.sourceId}`,
    occurredAt: new Date(),
  });
}

export interface SpeakReplyInput {
  tenantId: string;
  surface: ChatVoiceSurface;
  agentId: string | undefined;
  /** The reply as written, markdown and all. */
  text: string;
  sourceId: string;
}

export interface SpokenReply {
  audio: Buffer;
  mimeType: string;
  /** What the file should be called in the thread. */
  filename: string;
}

/**
 * Render a written reply as a playable file.
 *
 * Returns null whenever speaking is not possible, which the caller must treat as
 * ordinary: the text reply has already gone out, and the audio is a bonus.
 */
export async function speakReply(input: SpeakReplyInput): Promise<SpokenReply | null> {
  const spoken = toSpokenFile(input.text);
  // Nothing speakable — a reply that was only a code block, or only a link.
  if (spoken.length === 0) return null;

  try {
    const provider = resolveTtsProvider('memo_tts', input.tenantId);
    const voice = voiceFor(vendorForLane('memo_tts'), input.agentId);

    const { audio, mimeType, usage } = await provider.synthesizeFile({
      text: spoken,
      voice,
      language: undefined,
      // Nothing is listening to a file as it is made, so there is nothing to
      // interrupt; the contract wants a signal, so it gets one that never fires.
      signal: new AbortController().signal,
    });
    if (audio.length === 0) return null;

    await recordSynthesisCost({
      tenantId: input.tenantId,
      surface: input.surface,
      agentId: input.agentId,
      provider: provider.key,
      usage,
      sourceId: `voice-tts:${input.sourceId}`,
      occurredAt: new Date(),
    });

    log.info(
      { surface: input.surface, bytes: audio.length, provider: provider.key, model: usage.model },
      'Reply synthesised for a chat surface',
    );
    return { audio, mimeType, filename: 'reply.mp3' };
  } catch (err) {
    log.error(
      { error: (err as Error).message, surface: input.surface, tenantId: input.tenantId },
      'Reply could not be spoken; the written reply is unaffected',
    );
    return null;
  }
}
