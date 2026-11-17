// OpenAI Speech-to-Text — Realtime transcription sessions, and the batch endpoint.
//
// The listening counterpart to ./openai-tts, and the adapter that makes the lane
// table switchable in BOTH directions: until this existed, moving a speaking lane
// was a config edit and moving a listening lane was an error message.
//
// gpt-transcribe rather than one of the gpt-4o-* transcribe models, and the
// reason is billing rather than quality. Measured 2026-08-10 against the live
// API: gpt-4o-transcribe and gpt-4o-mini-transcribe answer with
// `{type:'tokens', input_token_details:{audio_tokens}}`, and OpenAI does not
// publish an audio-input token rate separate from text input — pricing them means
// inventing a factor, and a made-up factor in the ledger is worse than an
// expensive vendor. gpt-transcribe answers `{type:'duration', seconds}` against a
// published per-minute price, which is the same shape Cloud STT reports, so both
// vendors land on `audio_seconds` and nothing above this layer can tell them
// apart. gpt-live-transcribe was rejected outright: it refuses turn detection
// ("Turn detection is not supported for this transcription model"), and without
// turn detection there is no commit, so no final transcript and no usage at all.
//
// TURN DETECTION IS ALWAYS ON, even for dictation, and that is not a copy of what
// the Google adapter does. There, voice-activity events are an extra that
// dictation switches off. Here, server VAD is what COMMITS the audio buffer, and
// a buffer that is never committed produces no `completed` event — no settled
// text, and nothing to bill. So the session always runs VAD and `endpointing`
// gates only whether the speaker-stopped signal is passed upward.
//
// Everything OpenAI-specific stops at this file and the model id in ../vendors.

import { WebSocket } from 'ws';
import { log } from '../../infrastructure/logging';
import { getOpenAIApiKey } from '../../infrastructure/secrets';
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
const PROVIDER_KEY = 'openai';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * The ONLY rate a Realtime session accepts, verified by asking it 2026-08-10:
 * 8 k, 16 k, 44.1 k and 48 k are all rejected with an explicit
 * "Expected a value >= 24000 ... <= 24000". So this is not a preference to
 * negotiate, and anything else has to be converted before it is sent.
 */
const REQUIRED_SAMPLE_RATE = 24000;

/**
 * Capture rates this adapter will convert from.
 *
 * A browser's AudioContext runs at whatever the output device negotiated, not at
 * a number the page chooses: 48 kHz on most desktops, 44.1 kHz on plenty of
 * Windows machines, and 16 kHz on a Bluetooth headset in hands-free mode — which
 * is exactly the device someone reaches for to hold a conversation.
 */
const MIN_INPUT_RATE = 8000;
const MAX_INPUT_RATE = 96000;

/**
 * How long a silence ends a turn.
 *
 * Longer than OpenAI's 200 ms default, which fires on the pauses inside an
 * ordinary sentence: the same six-second recording came back as three segments
 * at the default and one at 500 ms. Dictation can afford the shorter setting
 * because a mid-sentence break only splits the text, but a conversation that
 * dispatches a turn every time somebody draws breath is unusable.
 */
const SPEECH_END_SILENCE_MS = 500;

/**
 * How long the speaker-stopped signal waits for the words that belong to it.
 *
 * THIS VENDOR TRANSCRIBES AFTER THE TURN IS COMMITTED, which inverts the order
 * Cloud STT produces and which every caller of `onSpeechEnd` was written
 * against. Measured 2026-08-10 on a 4.3-second utterance: `speech_stopped` at
 * 5251 ms, the first word at 6147 ms, the settled transcript at 6403 ms — the
 * end of the turn is announced 0.9-1.2 s BEFORE there is anything to read.
 *
 * Forwarding it immediately would tell the browser an utterance was over while
 * its transcript buffer was still empty, so the turn would complete with no
 * words, reset itself, and the sentence would land afterwards with nothing left
 * to send it. Every turn would run one beat ahead of the words, and any noise
 * that trips VAD would end an utterance nobody had spoken — stopping a reply in
 * a quiet room.
 *
 * Generous, because the wait costs nothing when words are coming: it is released
 * the moment the transcript lands, not when this expires.
 */
const TRANSCRIPT_WAIT_MS = 4000;

/**
 * Audio captured before the session finishes configuring.
 *
 * `openStream` is synchronous and the socket is not, so the first frames arrive
 * with nowhere to go. Holding roughly ten seconds of 24 kHz mono covers a slow
 * connect; past that the session is not coming up and buffering further would
 * trade a lost sentence for unbounded memory.
 */
const MAX_PENDING_BYTES = REQUIRED_SAMPLE_RATE * 2 * 10;

/** Matches ./google-stt: rotate a dead session, but not an instantly-dying one. */
const HEALTHY_SESSION_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;

/** How long `end()` waits for the committed tail to come back before settling. */
const FINAL_DRAIN_MS = 5000;

/**
 * Committing an empty buffer is expected, not a fault.
 *
 * `end()` commits unconditionally because it cannot know whether the speaker
 * left audio uncommitted. When they did not, OpenAI answers with this, and
 * reporting it as a session error would turn a clean stop into a logged failure.
 */
const EMPTY_COMMIT_ERROR = /buffer too small/i;

function buildUsage(seconds: number, model: string, unit: VoiceUsage['unit']): VoiceUsage {
  return { quantity: seconds, unit, model, costUsd: voiceUsageToCostUsd(model, seconds, unit) };
}

/**
 * Whatever the microphone captured, down (or up) to the 24 kHz the vendor demands.
 *
 * ANY rate, not just the browser's usual 48 kHz. The capture rate is a property
 * of the device, and assuming one is how a Bluetooth headset ends up sending
 * 16 kHz audio that gets read as 48 kHz: three times too fast, unintelligible,
 * and — measured — transcribed as nothing at all while the session reports it
 * heard no audio.
 *
 * Downsampling averages the whole source span behind each output sample rather
 * than picking one from it. That is both the resample and its anti-alias filter:
 * dropping samples folds everything above 12 kHz back down into speech, and a
 * box average over the span nulls exactly there. Upsampling interpolates between
 * neighbours, since there is no detail to invent and a repeated sample is a
 * step, which is heard as a buzz.
 *
 * The fractional remainder matters. Frames arrive on socket boundaries, not
 * sample boundaries, and at a ratio like 44100/24000 an output sample straddles
 * them. Position is carried between calls along with the unconsumed samples —
 * resetting it per frame would put a click at every frame boundary.
 */
export function _makeResampler(inputRate: number): (chunk: Buffer) => Buffer {
  if (inputRate === REQUIRED_SAMPLE_RATE) return (chunk) => chunk;
  if (!Number.isFinite(inputRate) || inputRate < MIN_INPUT_RATE || inputRate > MAX_INPUT_RATE) {
    throw new Error(
      `OpenAI transcription needs ${REQUIRED_SAMPLE_RATE} Hz and this adapter converts ` +
        `${MIN_INPUT_RATE}-${MAX_INPUT_RATE} Hz; got ${inputRate} Hz`,
    );
  }

  const ratio = inputRate / REQUIRED_SAMPLE_RATE;
  let carry = Buffer.alloc(0);
  /** Fractional read position, in source samples, into `carry` + the next chunk. */
  let position = 0;

  return (chunk: Buffer): Buffer => {
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const available = Math.floor(buf.length / 2);
    const at = (i: number): number => buf.readInt16LE(i * 2);

    const out: number[] = [];
    for (;;) {
      if (ratio >= 1) {
        const start = Math.floor(position);
        const end = Math.floor(position + ratio);
        // The span has to be complete, or the average is taken over a sentence
        // that has not finished arriving.
        if (end > available || end <= start) break;
        let sum = 0;
        for (let i = start; i < end; i++) sum += at(i);
        out.push(Math.round(sum / (end - start)));
      } else {
        const i = Math.floor(position);
        if (i + 1 >= available) break;
        const frac = position - i;
        out.push(Math.round(at(i) * (1 - frac) + at(i + 1) * frac));
      }
      position += ratio;
    }

    const consumed = Math.floor(position);
    // Copied rather than aliased: `subarray` would keep the caller's frame alive
    // for as long as the remainder is held.
    carry = Buffer.from(buf.subarray(consumed * 2));
    position -= consumed;

    const result = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      const s = out[i] as number;
      result.writeInt16LE(s > 32767 ? 32767 : s < -32768 ? -32768 : s, i * 2);
    }
    return result;
  };
}

interface RealtimeEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  usage?: { type?: string; seconds?: number };
}

function openStream(input: SttStreamInput, handlers: SttStreamHandlers): SttStream {
  const { model, billingUnit } = sttModelFor(PROVIDER_KEY);
  // Throws here, synchronously, if the capture rate cannot be converted — before
  // a socket is opened and before anything is billed.
  const resample = _makeResampler(input.sampleRateHertz);

  let ws: WebSocket | null = null;
  let ready = false;
  let ended = false;
  let failed = false;
  let openedAt = 0;
  let consecutiveFailures = 0;

  /** Frames captured before the session was ready to receive them. */
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  /**
   * Billed seconds, summed across completed segments AND across rotations. Each
   * `completed` event reports the duration of its own segment, so the session
   * total is the sum rather than the maximum.
   */
  let billedSeconds = 0;
  /** Deltas are fragments; the contract wants the best guess SO FAR. */
  let interim = '';
  /**
   * The vendor said the speaker stopped; we are waiting on their words before
   * saying so upward. Cleared without firing when no words ever arrive.
   */
  let pendingSpeechEnd = false;
  let speechEndTimer: NodeJS.Timeout | undefined;
  /** Resolves `end()` once the committed tail has come back, or time runs out. */
  let settleFinal: (() => void) | null = null;

  const send = (message: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  /** Stop waiting on words for a turn that is no longer going anywhere. */
  const clearSpeechEndWait = (): void => {
    pendingSpeechEnd = false;
    if (speechEndTimer) {
      clearTimeout(speechEndTimer);
      speechEndTimer = undefined;
    }
  };

  const sessionConfig = {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REQUIRED_SAMPLE_RATE },
          transcription: {
            model,
            ...(input.language ? { language: input.language } : {}),
          },
          turn_detection: {
            type: 'server_vad',
            silence_duration_ms: SPEECH_END_SILENCE_MS,
          },
        },
      },
    },
  };

  const onEvent = (event: RealtimeEvent): void => {
    switch (event.type) {
      case 'session.updated': {
        ready = true;
        for (const frame of pending) {
          send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
        }
        pending = [];
        pendingBytes = 0;
        return;
      }

      case 'input_audio_buffer.speech_started': {
        interim = '';
        return;
      }

      case 'input_audio_buffer.speech_stopped': {
        // HELD, NOT FORWARDED. See TRANSCRIPT_WAIT_MS: on this vendor the words
        // for a turn arrive AFTER the turn is committed, so passing the signal
        // straight through announces the end of an utterance nobody can read yet.
        //
        // Dictation never gets it at all: VAD still runs, because it is what
        // commits the buffer, but the person decides when they are done.
        if (!input.endpointing) return;
        pendingSpeechEnd = true;
        if (speechEndTimer) clearTimeout(speechEndTimer);
        // No words within the window means the sound was not a turn — a chair, a
        // cough, or the reply's own audio leaking back into an open microphone.
        // Dropping it is the whole point: a turn dispatched on a noise stops the
        // reply the person was listening to.
        speechEndTimer = setTimeout(() => {
          pendingSpeechEnd = false;
          speechEndTimer = undefined;
        }, TRANSCRIPT_WAIT_MS);
        return;
      }

      case 'conversation.item.input_audio_transcription.delta': {
        if (!event.delta) return;
        // Accumulated, because OpenAI streams increments while `onInterim`
        // promises a running best guess. Emitting the fragment alone would put
        // one word in the composer where a sentence belongs.
        interim += event.delta;
        handlers.onInterim(interim.trim());
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        interim = '';
        const transcript = event.transcript?.trim();
        if (transcript) handlers.onFinal(transcript);
        // Duration for THIS segment. Recorded even when the segment produced no
        // words: the vendor charged for listening to it either way.
        if (event.usage?.type === 'duration' && Number.isFinite(event.usage.seconds)) {
          billedSeconds += event.usage.seconds ?? 0;
        }
        // The turn ended, and NOW there are words to end it with. Released after
        // `onFinal` so a caller that reads its transcript buffer on this signal
        // finds the sentence already in it.
        if (pendingSpeechEnd) {
          pendingSpeechEnd = false;
          if (speechEndTimer) {
            clearTimeout(speechEndTimer);
            speechEndTimer = undefined;
          }
          if (transcript) handlers.onSpeechEnd();
        }
        settleFinal?.();
        return;
      }

      case 'error': {
        const message = event.error?.message ?? 'unknown realtime error';
        if (EMPTY_COMMIT_ERROR.test(message)) {
          // Nothing was waiting to be committed. `end()` must still settle.
          settleFinal?.();
          return;
        }
        failed = true;
        clearSpeechEndWait();
        handlers.onError(new Error(`OpenAI transcription: ${message}`));
        return;
      }

      default:
        return;
    }
  };

  /**
   * The session is gone. Unless we asked for that, open another one and keep
   * listening — a Realtime session carries its own expiry, and a conversation
   * outlives it.
   */
  const onSessionGone = (err: Error | null): void => {
    if (ended || failed) {
      settleFinal?.();
      return;
    }
    ready = false;
    ws = null;
    interim = '';
    clearSpeechEndWait();

    const lived = Date.now() - openedAt;
    consecutiveFailures = lived >= HEALTHY_SESSION_MS ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      failed = true;
      handlers.onError(err ?? new Error('OpenAI transcription session kept ending immediately'));
      return;
    }

    log.info(
      { provider: PROVIDER_KEY, livedMs: lived, reason: err?.message ?? 'ended' },
      'Voice: rotating the transcription session',
    );
    void connect();
  };

  async function connect(): Promise<void> {
    if (ended || failed) return;
    let socket: WebSocket;
    try {
      const apiKey = await getOpenAIApiKey();
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured — cannot transcribe');
      socket = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err) {
      failed = true;
      handlers.onError(err as Error);
      return;
    }

    ws = socket;
    openedAt = Date.now();

    socket.on('open', () => {
      if (ws !== socket) return;
      socket.send(JSON.stringify(sessionConfig));
    });

    socket.on('message', (raw: Buffer) => {
      if (ws !== socket) return;
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw.toString()) as RealtimeEvent;
      } catch {
        return;
      }
      onEvent(event);
    });

    // One handler per socket, guarded so a replaced session cannot report on
    // behalf of the live one.
    socket.on('error', (err: Error) => {
      if (ws !== socket) return;
      onSessionGone(err);
    });
    socket.on('close', () => {
      if (ws !== socket) return;
      onSessionGone(null);
    });
  }

  void connect();

  return {
    write(chunk: Buffer): void {
      if (ended || failed) return;
      const audio = resample(chunk);
      if (audio.length === 0) return;

      if (!ready) {
        // Dropped rather than queued without limit. Audio spoken into a session
        // that is still connecting is worth holding; audio spoken into one that
        // never will is a leak.
        if (pendingBytes + audio.length > MAX_PENDING_BYTES) return;
        pending.push(audio);
        pendingBytes += audio.length;
        return;
      }
      send({ type: 'input_audio_buffer.append', audio: audio.toString('base64') });
    },

    end(): Promise<VoiceUsage> {
      if (ended) return Promise.resolve(buildUsage(billedSeconds, model, billingUnit));
      ended = true;

      return new Promise<VoiceUsage>((resolve) => {
        // Held in an object because `finish` closes over the timer that has not
        // been created yet, and the timer's callback is `finish`.
        const drain: { timer?: NodeJS.Timeout } = {};
        let done = false;
        // Reached from three directions — the committed tail arriving, an empty
        // commit being refused, and the drain timeout — and only the first counts.
        const finish = (): void => {
          if (done) return;
          done = true;
          settleFinal = null;
          clearSpeechEndWait();
          if (drain.timer) clearTimeout(drain.timer);
          if (ws && ws.readyState === WebSocket.OPEN) ws.close();
          ws = null;
          if (billedSeconds === 0) {
            log.info({ provider: PROVIDER_KEY }, 'Voice listening session billed no audio');
          }
          resolve(buildUsage(billedSeconds, model, billingUnit));
        };

        if (!ws || ws.readyState !== WebSocket.OPEN || !ready) {
          finish();
          return;
        }

        // The last thing said is usually still uncommitted: server VAD closes a
        // turn on SILENCE, and a person who stops talking also stops sending
        // audio, so the silence never arrives. Without this the final sentence is
        // transcribed nowhere and billed as nothing — measured, not feared.
        settleFinal = finish;
        send({ type: 'input_audio_buffer.commit' });
        drain.timer = setTimeout(finish, FINAL_DRAIN_MS);
      });
    },
  };
}

/**
 * The container a recording is in, from its own first bytes.
 *
 * The transcription endpoint picks its decoder from the FILENAME, so the
 * extension is not cosmetic. Sniffing rather than trusting the declared MIME
 * type because the platforms lie in both directions: Slack labels a voice memo
 * `video/mp4` because the container is an MP4 whether or not it holds video, and
 * a webhook that has lost track sends `application/octet-stream`.
 */
export function _extensionForAudio(audio: Buffer, mimeType: string): string {
  const starts = (text: string, offset = 0): boolean =>
    audio.length >= offset + text.length && audio.toString('latin1', offset, offset + text.length) === text;

  if (starts('ftyp', 4)) return 'mp4';
  if (starts('OggS')) return 'ogg';
  if (starts('RIFF') && starts('WAVE', 8)) return 'wav';
  if (starts('fLaC')) return 'flac';
  if (starts('ID3')) return 'mp3';
  // MPEG audio frame sync: eleven set bits.
  if (audio.length >= 2 && audio[0] === 0xff && ((audio[1] as number) & 0xe0) === 0xe0) return 'mp3';
  // EBML, i.e. Matroska/WebM.
  if (audio.length >= 4 && audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) {
    return 'webm';
  }

  // Nothing recognised. The declared type is a worse signal than the bytes but a
  // better one than nothing.
  const declared = /^(?:audio|video)\/([a-z0-9.+-]+)/i.exec(mimeType)?.[1]?.toLowerCase();
  const fromMime: Record<string, string> = {
    mp4: 'mp4', 'x-m4a': 'm4a', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3',
    ogg: 'ogg', opus: 'ogg', wav: 'wav', 'x-wav': 'wav', webm: 'webm', flac: 'flac',
  };
  return (declared && fromMime[declared]) || 'mp4';
}

/**
 * Transcribe a finished recording.
 *
 * The batch endpoint rather than a Realtime session, for the same reason the
 * Google adapter uses its own: the audio was already complete when it reached
 * us, and pacing a file through a socket to imitate someone speaking it buys
 * nothing.
 */
async function recognizeFile(input: SttFileInput): Promise<SttFileResult> {
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured — cannot transcribe');
  const { model, billingUnit } = sttModelFor(PROVIDER_KEY);

  const form = new FormData();
  const extension = _extensionForAudio(input.audio, input.mimeType);
  form.append('file', new Blob([new Uint8Array(input.audio)]), `memo.${extension}`);
  form.append('model', model);
  if (input.language) form.append('language', input.language);

  const response = await fetch(TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI transcription failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  const body = (await response.json()) as { text?: string; usage?: { type?: string; seconds?: number } };
  const seconds =
    body.usage?.type === 'duration' && Number.isFinite(body.usage.seconds) ? (body.usage.seconds ?? 0) : 0;

  // Billed even when nothing was recognised, exactly as the streaming path is:
  // the vendor charged for listening to the file whether or not it held words.
  return { transcript: body.text?.trim() ?? '', usage: buildUsage(seconds, model, billingUnit) };
}

export const openaiSttProvider: SttProvider = {
  key: PROVIDER_KEY,
  capabilities: {
    batch: true,
    streaming: true,
    // A RANGE, as Cloud STT's is. The vendor itself takes exactly 24 kHz; this
    // is what the adapter will convert from, which is what a caller holding a
    // microphone actually needs to know.
    sampleRates: [MIN_INPUT_RATE, MAX_INPUT_RATE],
  },
  openStream,
  recognizeFile,
};
