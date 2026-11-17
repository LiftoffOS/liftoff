// Google Cloud Text-to-Speech — Chirp 3: HD, streaming.
//
// Streaming for the same reason the listening side streams: the wait before a
// voice starts is the whole experience. A one-shot synthesise cannot return
// anything until the entire sentence is rendered, so every sentence would begin
// with its own silence.
//
// The transport is a bidirectional gRPC stream. The first message carries the
// config and nothing else; text follows in later messages. Sending both at once
// is rejected, which is why the write order below is not an accident.
//
// Everything Google-specific stops at this file and the model id in ../vendors.

import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { google } from '@google-cloud/text-to-speech/build/protos/protos';
import { voiceUsageToCostUsd } from '../../cost-attribution/voice-pricing';
import { ttsModelFor } from '../vendors';
import type { TtsFileResult, TtsProvider, TtsSynthesisInput, VoiceUsage } from '../types';

/** Registry key. The one string tying this adapter to the vendor map. */
const PROVIDER_KEY = 'google';

const DEFAULT_LANGUAGE = 'en-US';

/**
 * Chirp 3: HD renders at 24 kHz. Declared rather than resampled — asking the API
 * for another rate makes it resample, which costs quality for nothing when the
 * browser resamples to its own output device regardless.
 */
const OUTPUT_SAMPLE_RATE = 24000;

let cachedClient: TextToSpeechClient | null = null;

function getClient(): TextToSpeechClient {
  if (!cachedClient) cachedClient = new TextToSpeechClient();
  return cachedClient;
}

export function _resetGoogleTtsClientForTesting(): void {
  cachedClient = null;
}

/**
 * The language a voice belongs to.
 *
 * Cloud TTS wants the language code alongside the voice name, and the name
 * already begins with it (`en-US-Chirp3-HD-Achernar`). Deriving it removes a
 * parameter that could disagree with the voice and produce a confusing rejection.
 */
export function _languageOfVoice(voice: string): string | null {
  return /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice)?.[1] ?? null;
}

async function* synthesize(input: TtsSynthesisInput): AsyncIterable<Buffer> {
  const text = input.text.trim();
  if (text.length === 0) return;
  if (input.signal.aborted) return;

  const language = input.language ?? _languageOfVoice(input.voice) ?? DEFAULT_LANGUAGE;
  // Characters are knowable from the text, and the vendor charges for the whole
  // request the moment it accepts it — so an abort partway does not make the
  // sentence free, and reporting now is both accurate and simplest.
  input.onUsage?.(usageFor(text));
  const stream = getClient().streamingSynthesize();

  // Chunks arrive on an event, but this function hands them back by iteration.
  // The queue is the join between the two: the stream pushes, the loop pulls,
  // and `wake` releases the loop whenever either has news.
  const queue: Buffer[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const nudge = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  stream.on('data', (response: google.cloud.texttospeech.v1.IStreamingSynthesizeResponse) => {
    const audio = response.audioContent;
    if (!audio) return;
    queue.push(typeof audio === 'string' ? Buffer.from(audio, 'base64') : Buffer.from(audio));
    nudge();
  });
  stream.on('error', (err: Error) => {
    // An abort tears the stream down on purpose; that is not a failure to report.
    if (!input.signal.aborted) failure = err;
    done = true;
    nudge();
  });
  stream.on('end', () => { done = true; nudge(); });

  const abort = (): void => { stream.destroy(); done = true; nudge(); };
  input.signal.addEventListener('abort', abort, { once: true });

  try {
    stream.write({
      streamingConfig: {
        voice: { name: input.voice, languageCode: language },
        streamingAudioConfig: {
          audioEncoding: 'PCM',
          sampleRateHertz: OUTPUT_SAMPLE_RATE,
        },
      },
    });
    stream.write({ input: { text } });
    stream.end();

    for (;;) {
      while (queue.length > 0) {
        const chunk = queue.shift() as Buffer;
        if (input.signal.aborted) return;
        yield chunk;
      }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    input.signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

function usageFor(text: string): VoiceUsage {
  const { model, billingUnit } = ttsModelFor(PROVIDER_KEY);
  // Characters submitted, which is what the SKU counts — not words, and not the
  // duration of the audio that came back.
  const quantity = text.length;
  return {
    quantity,
    unit: billingUnit,
    model,
    costUsd: voiceUsageToCostUsd(model, quantity, billingUnit),
  };
}

/**
 * Synthesise a whole reply into one MP3.
 *
 * MP3 rather than the PCM the browser gets, because this is an attachment: a
 * chat client needs a container it can play, and raw samples are not one.
 */
async function synthesizeFile(input: TtsSynthesisInput): Promise<TtsFileResult> {
  const text = input.text.trim();
  const language = input.language ?? _languageOfVoice(input.voice) ?? DEFAULT_LANGUAGE;

  const [response] = await getClient().synthesizeSpeech({
    input: { text },
    voice: { name: input.voice, languageCode: language },
    audioConfig: { audioEncoding: 'MP3' },
  });

  const content = response.audioContent;
  const audio = !content
    ? Buffer.alloc(0)
    : typeof content === 'string'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content);

  return { audio, mimeType: 'audio/mpeg', usage: usageFor(text) };
}

export const googleTtsProvider: TtsProvider = {
  key: PROVIDER_KEY,
  capabilities: {
    streaming: true,
    outputSampleRateHertz: OUTPUT_SAMPLE_RATE,
  },
  synthesize,
  synthesizeFile,
  usageFor,
};
