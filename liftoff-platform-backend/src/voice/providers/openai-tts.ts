// OpenAI Text-to-Speech.
//
// The second speaking adapter, and the reason the lane table is worth having:
// with two real implementations, moving the speaking lane is a one-line edit
// that a test can actually exercise, rather than a claim.
//
// OpenAI is NOT a new subprocessor — it is already a platform LLM provider with
// its own platform key, so tenant text reaches it today. That is what makes it
// the cheapest vendor to add: `tts-1` is roughly half Chirp 3: HD per character
// with no legal work at all.
//
// gpt-4o-mini-tts, the steerable model. It bills audio TOKENS rather than
// characters, which is exactly what VoiceBillingUnit has carried an
// 'audio_tokens' member for since the beginning. An earlier version of this file
// chose tts-1 to keep every lane on characters and measured 2-3x worse for it:
// ~2.5s to first byte against ~0.8s here.
//
// It streams over SSE rather than as a raw body, because that is the only mode
// that reports what it charged. The stream ends with a `speech.audio.done` event
// carrying real token counts, so the ledger records what the vendor billed
// instead of an estimate derived from the text.

import { getOpenAIApiKey } from '../../infrastructure/secrets';
import { openaiSpeechCostUsd, voiceUsageToCostUsd } from '../../cost-attribution/voice-pricing';
import { ttsModelFor } from '../vendors';
import type { TtsFileResult, TtsProvider, TtsSynthesisInput, VoiceUsage } from '../types';

/** Registry key. The one string tying this adapter to the vendor map. */
const PROVIDER_KEY = 'openai';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/**
 * OpenAI's `pcm` is raw 16-bit signed little-endian mono at 24 kHz — the same
 * rate Chirp 3: HD emits, so the browser needs no change to play either vendor.
 */
const OUTPUT_SAMPLE_RATE = 24000;

/** Longest input the endpoint accepts. The chunker emits far less than this. */
const MAX_INPUT_CHARS = 4096;

/**
 * Audio tokens this model produces per character of ordinary prose.
 *
 * Measured 2026-08-10 against the live API: a 386-character reply reported 520
 * audio output tokens. Only used to size text nobody has synthesised yet — every
 * ledger row comes from what the vendor reported.
 */
const AUDIO_TOKENS_PER_CHAR = 1.35;

/**
 * Audio tokens per SECOND of emitted audio, and the bytes that make a second.
 *
 * Measured 2026-08-10 across three lengths: 1.60 s → 45 tokens, 3.30 s → 87,
 * 12.30 s → 297. That is ~23.5 per second plus a small fixed per-call overhead,
 * which is why the short clip reads high (28/s) and the long one settles near 24.
 *
 * Used for ONE case: barge-in, where the person spoke over the reply and the
 * vendor never got to say what it charged. The alternative is reporting zero for
 * audio that was demonstrably produced — see `synthesize`.
 */
const AUDIO_TOKENS_PER_SECOND = 24;
const PCM_BYTES_PER_SECOND = 48000;

async function requestSpeech(
  input: TtsSynthesisInput,
  responseFormat: 'pcm' | 'mp3',
  streamed: boolean,
): Promise<Response> {
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured — cannot synthesise speech');

  const { model } = ttsModelFor(PROVIDER_KEY);
  const response = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice: input.voice,
      input: input.text.slice(0, MAX_INPUT_CHARS),
      response_format: responseFormat,
      // Steering lives here when we want it; the parameter is the reason this
      // model was chosen over the cheaper ones.
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(streamed ? { stream_format: 'sse' } : {}),
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    // The body carries the actual reason (bad voice, quota, malformed input);
    // a bare status code sends whoever reads this to the wrong place.
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI speech failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  return response;
}

interface OpenAiSpeechEvent {
  type?: string;
  audio?: string;
  usage?: OpenAiSpeechUsage;
}

/**
 * The blank line between SSE frames.
 *
 * CRLF, AND bare LF. This endpoint really sends `\r\n\r\n` — checked against the
 * live response, where a 54 KB stream contained seventy-five frames and not one
 * occurrence of `\n\n`. Splitting on `\n\n` alone therefore never finds a frame
 * boundary: the reader buffers the entire response, yields no audio and reports
 * no usage, while the request itself succeeds and nothing throws — a failure
 * that stays invisible while no lane calls the adapter. Bare LF stays accepted because
 * the spec allows either and a vendor is free to change which it sends.
 */
const SSE_FRAME_BREAK = /\r?\n\r?\n/;

/**
 * The SSE frames of one speech response, parsed.
 *
 * Shared by both synthesis paths so that neither can quietly drift onto a
 * different idea of what the call cost.
 */
async function* speechEvents(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<OpenAiSpeechEvent> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) return;

      buffered += decoder.decode(value, { stream: true });
      // A frame is often larger than one network chunk — the base64 audio of a
      // single delta runs to tens of kilobytes — so a partial frame stays in the
      // buffer until the rest of it arrives.
      for (;;) {
        const brk = SSE_FRAME_BREAK.exec(buffered);
        if (!brk) break;
        const frame = buffered.slice(0, brk.index);
        buffered = buffered.slice(brk.index + brk[0].length);

        const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          yield JSON.parse(payload) as OpenAiSpeechEvent;
        } catch {
          continue;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function* synthesize(input: TtsSynthesisInput): AsyncIterable<Buffer> {
  if (input.text.trim().length === 0) return;
  if (input.signal.aborted) return;

  const response = await requestSpeech(input, 'pcm', true);
  let reported = false;
  let emittedBytes = 0;

  try {
    for await (const event of speechEvents(response, input.signal)) {
      if (input.signal.aborted) return;
      if (event.type === 'speech.audio.delta' && event.audio) {
        const chunk = Buffer.from(event.audio, 'base64');
        emittedBytes += chunk.length;
        yield chunk;
      } else if (event.type === 'speech.audio.done') {
        reported = true;
        input.onUsage?.(usageFromTokens(event.usage));
      }
    }
  } finally {
    // BARGE-IN STILL BILLS. The person spoke over the reply, the request was
    // aborted, and the vendor never sent `speech.audio.done` — so there is no
    // reported figure. Reporting nothing was the old answer and it silently
    // under-charged: the Google adapter reports the whole sentence up front, so
    // an interrupted sentence bills there and billed nothing here. Worse, when
    // the interruption lands during the FIRST sentence, `speak-ws` writes no
    // ledger row at all and the turn consumes no Operating Units.
    //
    // The audio that did arrive is not a guess — it was produced and charged
    // for — so it is converted at the measured rate above. A floor rather than
    // an invention: the vendor generated at least this much.
    if (!reported) input.onUsage?.(usageFromAudio(emittedBytes));
  }
}

/**
 * Synthesise a whole reply into one MP3.
 *
 * STREAMED, even though nobody is waiting on the first byte of an attachment.
 * The plain response body returns the same audio in one piece and says nothing
 * about what it cost, which left this path billing `usageFor` — a guess of one
 * audio token per two characters. Measured against the live API, the real ratio
 * is about 1.35, so every spoken reply on a chat surface under-billed by roughly
 * two thirds and could never reconcile against an invoice. Asking for SSE costs
 * nothing here and ends with the same `speech.audio.done` the browser path
 * bills from.
 */
async function synthesizeFile(input: TtsSynthesisInput): Promise<TtsFileResult> {
  const response = await requestSpeech(input, 'mp3', true);

  const chunks: Buffer[] = [];
  let reported: VoiceUsage | undefined;
  for await (const event of speechEvents(response, input.signal)) {
    if (event.type === 'speech.audio.delta' && event.audio) {
      chunks.push(Buffer.from(event.audio, 'base64'));
    } else if (event.type === 'speech.audio.done') {
      reported = usageFromTokens(event.usage);
    }
  }

  // A response that ended without saying what it charged is reported as zero
  // rather than estimated, for the same reason the streaming path does it.
  const usage = reported ?? usageFromTokens(undefined);
  input.onUsage?.(usage);
  return { audio: Buffer.concat(chunks), mimeType: 'audio/mpeg', usage };
}

interface OpenAiSpeechUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Usage derived from the audio that actually arrived.
 *
 * Only for an interrupted stream, where the vendor never reported. Anchored to
 * output we received rather than to input text: what OpenAI charges for is the
 * audio it produced, and this is the part of it we observed.
 */
function usageFromAudio(emittedBytes: number): VoiceUsage {
  const { model, billingUnit } = ttsModelFor(PROVIDER_KEY);
  const seconds = emittedBytes / PCM_BYTES_PER_SECOND;
  const quantity = Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND);
  return {
    quantity,
    unit: billingUnit,
    model,
    costUsd: voiceUsageToCostUsd(model, quantity, billingUnit),
  };
}

/** Usage from what the vendor reported, priced across both of its rates. */
function usageFromTokens(usage: OpenAiSpeechUsage | undefined): VoiceUsage {
  const { model, billingUnit } = ttsModelFor(PROVIDER_KEY);
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    // The audio it produced is the meaningful quantity; the text it read is
    // priced in but is a rounding error beside it.
    quantity: outputTokens,
    unit: billingUnit,
    model,
    costUsd: openaiSpeechCostUsd(inputTokens, outputTokens),
  };
}

/**
 * An ESTIMATE, and no longer on any billing path.
 *
 * This vendor bills audio tokens, which cannot be known before it runs. Both
 * synthesis paths now report what the vendor said through `onUsage`, so the only
 * thing callers still want from here is the MODEL and UNIT that label a ledger
 * row — `speak-ws` asks with an empty string for exactly that.
 *
 * The quantity is kept honest anyway rather than zeroed, because a caller that
 * wanted a rough size before synthesising should get a defensible one: measured
 * against the live API, gpt-4o-mini-tts produces about 1.35 audio tokens per
 * character of ordinary prose. The 0.5 that used to sit here was not measured,
 * and while `synthesizeFile` billed from it every spoken chat reply under-charged
 * by roughly two thirds.
 */
function usageFor(text: string): VoiceUsage {
  const { model, billingUnit } = ttsModelFor(PROVIDER_KEY);
  const quantity = Math.ceil(Math.min(text.length, MAX_INPUT_CHARS) * AUDIO_TOKENS_PER_CHAR);
  return {
    quantity,
    unit: billingUnit,
    model,
    costUsd: voiceUsageToCostUsd(model, quantity, billingUnit),
  };
}

export const openaiTtsProvider: TtsProvider = {
  key: PROVIDER_KEY,
  capabilities: {
    streaming: true,
    outputSampleRateHertz: OUTPUT_SAMPLE_RATE,
  },
  synthesize,
  synthesizeFile,
  usageFor,
};
