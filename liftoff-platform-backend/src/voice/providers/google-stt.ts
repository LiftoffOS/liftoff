// Google Cloud Speech-to-Text v2 — live streaming recognition.
//
// Streaming rather than batch because dictation shows words as they are spoken.
// A batch call cannot answer until the audio stops, which is the difference
// between a composer that fills in as you talk and one that sits blank and then
// pastes everything at once.
//
// Everything Google-specific is confined to this file and to the model id in
// ../vendors.ts. Nothing above this layer knows which vendor transcribed.

import { v2 } from '@google-cloud/speech';
import type { google } from '@google-cloud/speech/build/protos/protos';
import { log } from '../../infrastructure/logging';
import { voiceUsageToCostUsd } from '../../cost-attribution/voice-pricing';
import { sttModelFor } from '../vendors';
import type {
  SttFileInput,
  SttFileResult,
  SttProvider,
  SttStream,
  SttStreamHandlers,
  SttStreamInput,
  VoiceUsage,
} from '../types';

/** Registry key. The one string that ties this adapter to the vendor map. */
const PROVIDER_KEY = 'google';

const DEFAULT_LANGUAGE = 'en-US';

/** Cloud STT v2 accepts 8000-48000 Hz; both bounds inclusive. */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;

let cachedClient: v2.SpeechClient | null = null;

function getClient(): v2.SpeechClient {
  if (!cachedClient) cachedClient = new v2.SpeechClient();
  return cachedClient;
}

export function _resetGoogleSttClientForTesting(): void {
  cachedClient = null;
}

/**
 * Billed audio duration in seconds, from the response metadata.
 *
 * Deliberately not measured from the frames we sent: `totalBilledDuration` is
 * what Google actually charges for, so it is the only number that reconciles
 * against an invoice.
 */
export function _billedSeconds(
  duration: google.protobuf.IDuration | null | undefined,
): number {
  if (!duration) return 0;
  const seconds = Number(duration.seconds ?? 0);
  const nanos = Number(duration.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return 0;
  return seconds + nanos / 1e9;
}

function buildUsage(quantity: number, model: string, unit: VoiceUsage['unit']): VoiceUsage {
  return { quantity, unit, model, costUsd: voiceUsageToCostUsd(model, quantity, unit) };
}

/**
 * How long an upstream must survive before a rotation counts as healthy.
 *
 * Cloud STT ends a recognition stream routinely — at its own five-minute
 * ceiling, and when a voice-activity timeout expires — and the right response is
 * to open another one. A stream that dies immediately, repeatedly, is a
 * different thing: a bad config or a missing permission, which rotating cannot
 * fix and would retry forever.
 */
const HEALTHY_UPSTREAM_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;

function openStream(input: SttStreamInput, handlers: SttStreamHandlers): SttStream {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is not set — cannot resolve a Cloud STT recognizer');
  }
  if (input.sampleRateHertz < MIN_SAMPLE_RATE || input.sampleRateHertz > MAX_SAMPLE_RATE) {
    throw new Error(
      `Cloud STT accepts ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz, got ${input.sampleRateHertz}`,
    );
  }

  const { model, billingUnit } = sttModelFor(PROVIDER_KEY);

  /**
   * Billed duration is cumulative WITHIN one upstream and restarts with the next
   * one, so the total is the sum of each stream's own maximum.
   */
  let billedClosed = 0;
  let billedCurrent = 0;

  let ended = false;
  let failed = false;
  let upstream: ReturnType<v2.SpeechClient['_streamingRecognize']> | null = null;
  let openedAt = 0;
  let consecutiveFailures = 0;
  let settle: (() => void) | null = null;

  const configMessage = {
    recognizer: `projects/${projectId}/locations/global/recognizers/_`,
    streamingConfig: {
      config: {
        // LINEAR16 because the client sends raw PCM frames from an AudioWorklet.
        // A container cannot be streamed frame by frame: only its first chunk
        // carries the headers a decoder needs.
        explicitDecodingConfig: {
          encoding: 'LINEAR16' as const,
          sampleRateHertz: input.sampleRateHertz,
          audioChannelCount: 1,
        },
        languageCodes: [input.language ?? DEFAULT_LANGUAGE],
        model,
      },
      // Interim results are the entire point: they are what appears in the
      // composer while the person is still speaking.
      streamingFeatures: {
        interimResults: true,
        ...(input.endpointing
          ? {
              enableVoiceActivityEvents: true,
              voiceActivityTimeout: {
                // How long a silence has to last before the turn is treated as
                // over. Short enough that a reply does not feel withheld, long
                // enough to survive someone drawing breath mid-thought.
                //
                // NO speechStartTimeout. Setting one ended the stream whenever
                // the person listened without speaking — which is most of a
                // conversation — and the session died mid-reply.
                speechEndTimeout: { seconds: 1 },
              },
            }
          : {}),
      },
    },
  };

  const onData = (response: google.cloud.speech.v2.IStreamingRecognizeResponse): void => {
    const reported = _billedSeconds(response.metadata?.totalBilledDuration);
    if (reported > billedCurrent) billedCurrent = reported;

    // The speaker stopped. Reported ahead of the final transcript, which is what
    // makes it useful: the turn can be prepared before the words settle.
    if (response.speechEventType === 'SPEECH_ACTIVITY_END') {
      handlers.onSpeechEnd();
    }

    for (const result of response.results ?? []) {
      const transcript = result.alternatives?.[0]?.transcript?.trim();
      if (!transcript) continue;
      if (result.isFinal) handlers.onFinal(transcript);
      else handlers.onInterim(transcript);
    }
  };

  /**
   * The upstream is gone. Bank what it billed and, unless we asked for this,
   * open another one so the listening session outlives it.
   */
  const onUpstreamGone = (err: Error | null): void => {
    if (ended || failed) {
      settle?.();
      return;
    }
    billedClosed += billedCurrent;
    billedCurrent = 0;

    const lived = Date.now() - openedAt;
    consecutiveFailures = lived >= HEALTHY_UPSTREAM_MS ? 0 : consecutiveFailures + 1;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      failed = true;
      upstream = null;
      handlers.onError(err ?? new Error('Cloud STT stream kept ending immediately'));
      return;
    }

    log.info(
      { provider: PROVIDER_KEY, livedMs: lived, reason: err?.message ?? 'ended' },
      'Voice: rotating the recognition stream',
    );
    connect();
  };

  function connect(): void {
    const next = getClient()._streamingRecognize();
    upstream = next;
    openedAt = Date.now();

    next.on('data', onData);
    // One handler, one report. Without the `upstream === next` guard every
    // frame written into a dead stream raised its own error, which is how a
    // single upstream ending became hundreds of errors and a closed socket.
    next.on('error', (err: Error) => {
      if (upstream !== next) return;
      upstream = null;
      onUpstreamGone(err);
    });
    next.on('end', () => {
      if (upstream !== next) return;
      upstream = null;
      onUpstreamGone(null);
    });

    next.write(configMessage);
  }

  connect();

  const totalBilled = (): number => billedClosed + billedCurrent;

  return {
    write(chunk: Buffer): void {
      const target = upstream;
      // No upstream means one is being replaced, or the session is over. Audio
      // spoken in that window is lost rather than fatal — the alternative was
      // writing into a destroyed stream, which killed the whole session.
      if (ended || failed || !target || target.destroyed) return;
      try {
        target.write({ audio: chunk });
      } catch {
        // Raced the upstream closing. The error handler owns the recovery.
      }
    },

    end(): Promise<VoiceUsage> {
      if (ended) return Promise.resolve(buildUsage(totalBilled(), model, billingUnit));
      ended = true;
      return new Promise<VoiceUsage>((resolve) => {
        const finish = (): void => {
          if (billedClosed + billedCurrent === 0) {
            log.info({ provider: PROVIDER_KEY }, 'Voice listening session billed no audio');
          }
          resolve(buildUsage(totalBilled(), model, billingUnit));
        };
        settle = finish;
        const target = upstream;
        if (!target || target.destroyed) {
          finish();
          return;
        }
        target.once('end', finish);
        // An upstream that never closes must not hold the ledger write hostage.
        target.once('error', finish);
        target.end();
      });
    },
  };
}

/**
 * Transcribe a finished recording.
 *
 * `autoDecodingConfig` rather than an explicit one: the audio arrived as a
 * container from Slack or Teams, and its headers already state the rate and
 * encoding. Declaring them ourselves is how a wrong-rate transcript happens —
 * Opus in particular does not preserve the original rate (RFC 7845), so the
 * number a platform reports is not the number to send.
 */
async function recognizeFile(input: SttFileInput): Promise<SttFileResult> {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is not set — cannot resolve a Cloud STT recognizer');
  }
  const { model, billingUnit } = sttModelFor(PROVIDER_KEY);

  const [response] = await getClient().recognize({
    recognizer: `projects/${projectId}/locations/global/recognizers/_`,
    config: {
      autoDecodingConfig: {},
      languageCodes: [input.language ?? DEFAULT_LANGUAGE],
      model,
    },
    content: input.audio,
  });

  const transcript = (response.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();

  // Billed even when nothing was recognised: the vendor charged for listening
  // to the file either way, and skipping the row would under-bill and break
  // reconciliation.
  const seconds = _billedSeconds(response.metadata?.totalBilledDuration);
  return { transcript, usage: buildUsage(seconds, model, billingUnit) };
}

export const googleSttProvider: SttProvider = {
  key: PROVIDER_KEY,
  capabilities: {
    batch: true,
    streaming: true,
    sampleRates: [MIN_SAMPLE_RATE, MAX_SAMPLE_RATE],
  },
  openStream,
  recognizeFile,
};
