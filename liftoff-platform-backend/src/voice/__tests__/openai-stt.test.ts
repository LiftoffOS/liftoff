// The OpenAI listening adapter's contract: the browser's 48 kHz is converted
// without losing samples at frame boundaries, incremental deltas are presented as
// a running best guess, the speaker-stopped signal is gated on who asked for it,
// and the tail that server VAD never closed is still committed, transcribed and
// billed.

import { EventEmitter } from 'node:events';

jest.mock('../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));

jest.mock('ws', () => {
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events');
  const sockets: FakeSocket[] = [];

  class FakeSocket extends Emitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    sent: Record<string, unknown>[] = [];
    closed = false;

    constructor(
      public url: string,
      public options: unknown,
    ) {
      super();
      sockets.push(this);
    }

    send(raw: string): void {
      this.sent.push(JSON.parse(raw) as Record<string, unknown>);
    }

    close(): void {
      this.closed = true;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close');
    }

    /** A server event arriving on the wire. */
    deliver(event: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(event)));
    }
  }

  return { WebSocket: FakeSocket, __sockets: sockets };
});

import { openaiSttProvider, _makeResampler, _extensionForAudio } from '../providers/openai-stt';
import type { SttStreamHandlers } from '../types';

interface FakeSocket extends EventEmitter {
  readyState: number;
  sent: Record<string, unknown>[];
  closed: boolean;
  close(): void;
  deliver(event: unknown): void;
}

const sockets = (jest.requireMock('ws') as { __sockets: FakeSocket[] }).__sockets;

/** Let the adapter's async connect settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Raw 16-bit LE PCM from a list of sample values. */
const pcm = (...samples: number[]): Buffer => {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
};

const samplesOf = (buf: Buffer): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
};

function collectHandlers(): SttStreamHandlers & {
  interims: string[];
  finals: string[];
  speechEnds: number;
  errors: Error[];
} {
  const state = { interims: [] as string[], finals: [] as string[], speechEnds: 0, errors: [] as Error[] };
  return {
    ...state,
    onInterim(t) { this.interims.push(t); },
    onFinal(t) { this.finals.push(t); },
    onSpeechEnd() { this.speechEnds++; },
    onError(e) { this.errors.push(e); },
  } as SttStreamHandlers & typeof state;
}

/** Bring a session up to the point where it is accepting audio. */
async function openReadySession(endpointing: boolean) {
  sockets.length = 0;
  const handlers = collectHandlers();
  const stream = openaiSttProvider.openStream(
    { sampleRateHertz: 48000, language: undefined, endpointing },
    handlers,
  );
  await flush();
  const socket = sockets[0] as FakeSocket;
  socket.emit('open');
  socket.deliver({ type: 'session.updated' });
  return { stream, socket, handlers };
}

beforeEach(() => {
  sockets.length = 0;
});

describe('48 kHz to 24 kHz conversion', () => {
  it('averages sample pairs rather than discarding every other one', () => {
    const resample = _makeResampler(48000);
    expect(samplesOf(resample(pcm(100, 200, 300, 400)))).toEqual([150, 350]);
  });

  it('passes 24 kHz through untouched', () => {
    const resample = _makeResampler(24000);
    const frame = pcm(1, 2, 3);
    expect(resample(frame)).toBe(frame);
  });

  it('CARRIES THE REMAINDER across frame boundaries', () => {
    // Frames arrive on socket boundaries, not sample boundaries. Dropping the
    // leftover would put a click in the audio at the seam of every frame, and
    // shift every following pair by one sample.
    const resample = _makeResampler(48000);
    const whole = pcm(100, 200, 300, 400);

    // Split mid-sample: three bytes, then the remaining five.
    const first = resample(whole.subarray(0, 3));
    const second = resample(whole.subarray(3));

    expect(samplesOf(first)).toEqual([]);
    expect(samplesOf(second)).toEqual([150, 350]);
  });

  it('CONVERTS A BLUETOOTH HEADSET RATE instead of assuming the desktop one', () => {
    // 16 kHz up to 24 kHz. Read as 48 kHz — which the server used to assume for
    // everyone — this audio was three times too fast and came back as an empty
    // transcript with the session reporting it heard nothing.
    const resample = _makeResampler(16000);
    const out = samplesOf(resample(pcm(0, 300, 600, 900, 1200, 1500)));
    // Two source samples become three, so six become nine.
    expect(out.length).toBeGreaterThan(6);
    // Interpolated, not repeated: a held sample is a step, and steps buzz.
    expect(new Set(out).size).toBeGreaterThan(3);
    expect(Math.max(...out)).toBeLessThanOrEqual(1500);
  });

  it('converts a 44.1 kHz capture, where a sample straddles frame boundaries', () => {
    const resample = _makeResampler(44100);
    // A ramp, fed in awkward 7-sample frames so the fractional position has to
    // survive between calls.
    const source: number[] = [];
    for (let i = 0; i < 441; i++) source.push(i * 10);
    const out: number[] = [];
    for (let i = 0; i < source.length; i += 7) {
      out.push(...samplesOf(resample(pcm(...source.slice(i, i + 7)))));
    }
    // 441 in at 44.1 kHz is 10 ms, which is 240 out at 24 kHz.
    expect(out.length).toBeGreaterThan(225);
    expect(out.length).toBeLessThanOrEqual(240);
    // Monotonic in, monotonic out — a dropped or reused remainder shows up here
    // as a step backwards at a frame seam.
    for (let i = 1; i < out.length; i++) {
      expect(out[i] as number).toBeGreaterThanOrEqual(out[i - 1] as number);
    }
  });

  it('refuses a rate no microphone produces rather than guessing', () => {
    expect(() => _makeResampler(4000)).toThrow(/converts 8000-96000 Hz/);
    expect(() => _makeResampler(192000)).toThrow(/converts 8000-96000 Hz/);
  });
});

describe('container sniffing for the batch endpoint', () => {
  it('reads the container from the bytes, not the declared type', () => {
    // Slack labels a voice memo `video/mp4` because the container is an MP4
    // whether or not it holds video.
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypM4A ')]);
    expect(_extensionForAudio(mp4, 'video/mp4')).toBe('mp4');
    expect(_extensionForAudio(Buffer.from('OggS...'), 'application/octet-stream')).toBe('ogg');
    expect(_extensionForAudio(Buffer.from('ID3Тest'), 'application/octet-stream')).toBe('mp3');
  });

  it('falls back to the declared type when the bytes say nothing', () => {
    const opaque = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(_extensionForAudio(opaque, 'audio/ogg')).toBe('ogg');
    expect(_extensionForAudio(opaque, 'audio/x-m4a')).toBe('m4a');
  });
});

describe('a live listening session', () => {
  it('configures the session for 24 kHz with server VAD before sending audio', async () => {
    const { socket } = await openReadySession(true);
    const update = socket.sent[0] as {
      type: string;
      session: { audio: { input: Record<string, unknown> } };
    };
    expect(update.type).toBe('session.update');
    const input = update.session.audio.input as {
      format: { rate: number };
      turn_detection: { type: string };
      transcription: { model: string };
    };
    expect(input.format.rate).toBe(24000);
    expect(input.transcription.model).toBe('gpt-transcribe');
    // Always on, even for dictation: VAD is what commits the buffer, and an
    // uncommitted buffer settles no transcript and reports no usage.
    expect(input.turn_detection.type).toBe('server_vad');
  });

  it('holds audio captured before the session was ready, then sends it', async () => {
    sockets.length = 0;
    const handlers = collectHandlers();
    const stream = openaiSttProvider.openStream(
      { sampleRateHertz: 48000, language: undefined, endpointing: false },
      handlers,
    );
    await flush();
    const socket = sockets[0] as FakeSocket;
    socket.emit('open');

    // Spoken into a session that has not finished configuring.
    stream.write(pcm(100, 200, 300, 400));
    expect(socket.sent.filter((m) => m['type'] === 'input_audio_buffer.append')).toHaveLength(0);

    socket.deliver({ type: 'session.updated' });
    expect(socket.sent.filter((m) => m['type'] === 'input_audio_buffer.append')).toHaveLength(1);
  });

  it('presents incremental deltas as a running best guess', async () => {
    const { socket, handlers } = await openReadySession(false);
    const h = handlers as unknown as { interims: string[]; finals: string[] };

    socket.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: 'The deploy' });
    socket.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: 'ment finished' });

    // Not ['The deploy', 'ment finished'] — the contract is "best guess so far",
    // and a composer fed the fragments alone would show one word.
    expect(h.interims).toEqual(['The deploy', 'The deployment finished']);

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'The deployment finished.',
      usage: { type: 'duration', seconds: 3 },
    });
    expect(h.finals).toEqual(['The deployment finished.']);

    // A new segment starts from nothing rather than from the last one's text.
    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    socket.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Next' });
    expect(h.interims.at(-1)).toBe('Next');
  });

  it('reports the speaker stopping only when the caller asked for it', async () => {
    const dictation = await openReadySession(false);
    dictation.socket.deliver({ type: 'input_audio_buffer.speech_stopped' });
    dictation.socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'some words',
      usage: { type: 'duration', seconds: 2 },
    });
    // Dictation still runs VAD, but the person decides when they are done —
    // telling the client a turn ended would dispatch it mid-thought.
    expect((dictation.handlers as unknown as { speechEnds: number }).speechEnds).toBe(0);
  });

  it('HOLDS SPEECH END UNTIL THE WORDS ARRIVE, because this vendor transcribes after the commit', async () => {
    // The defect this pins: `speech_stopped` lands 0.9-1.2s BEFORE the first
    // word. Passing it straight through told the browser an utterance was over
    // while its transcript buffer was still empty, so the turn completed with no
    // words, reset itself, and the sentence arrived with nothing left to send it.
    const { socket, handlers } = await openReadySession(true);
    const h = handlers as unknown as { finals: string[]; speechEnds: number };

    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    socket.deliver({ type: 'input_audio_buffer.speech_stopped' });

    // Nothing yet — the words have not landed.
    expect(h.speechEnds).toBe(0);

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Summarise yesterday.',
      usage: { type: 'duration', seconds: 4 },
    });

    expect(h.finals).toEqual(['Summarise yesterday.']);
    expect(h.speechEnds).toBe(1);
  });

  it('NEVER ENDS A TURN ON A SOUND THAT PRODUCED NO WORDS', async () => {
    // A chair, a cough, or the reply's own audio leaking into an open mic. VAD
    // fires, the transcript comes back empty, and a turn dispatched on that
    // stops the reply the person was listening to — in a silent room.
    const { socket, handlers } = await openReadySession(true);
    const h = handlers as unknown as { speechEnds: number; finals: string[] };

    socket.deliver({ type: 'input_audio_buffer.speech_stopped' });
    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '   ',
      usage: { type: 'duration', seconds: 1 },
    });

    expect(h.finals).toEqual([]);
    expect(h.speechEnds).toBe(0);
  });

  it('gives up on a held turn when no transcript ever arrives', async () => {
    jest.useFakeTimers();
    try {
      sockets.length = 0;
      const handlers = collectHandlers();
      const stream = openaiSttProvider.openStream(
        { sampleRateHertz: 48000, language: undefined, endpointing: true },
        handlers,
      );
      await Promise.resolve();
      await Promise.resolve();
      const socket = sockets[0] as FakeSocket;
      socket.emit('open');
      socket.deliver({ type: 'session.updated' });

      socket.deliver({ type: 'input_audio_buffer.speech_stopped' });
      jest.advanceTimersByTime(4001);
      // The window closed with nothing to say, so a transcript that turns up
      // later belongs to the NEXT utterance and must not end this one.
      socket.deliver({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'late words',
        usage: { type: 'duration', seconds: 1 },
      });
      expect((handlers as unknown as { speechEnds: number }).speechEnds).toBe(0);
      void stream;
    } finally {
      jest.useRealTimers();
    }
  });

  it('COMMITS THE TAIL ON END, and bills every segment of the session', async () => {
    const { stream, socket, handlers } = await openReadySession(true);

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'First part.',
      usage: { type: 'duration', seconds: 4 },
    });

    const settled = stream.end();
    // Server VAD closes a turn on silence, and somebody who stops talking also
    // stops sending audio — so without this commit the last sentence is
    // transcribed nowhere and billed as nothing.
    expect(socket.sent.some((m) => m['type'] === 'input_audio_buffer.commit')).toBe(true);

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'And the tail.',
      usage: { type: 'duration', seconds: 3 },
    });

    const usage = await settled;
    expect((handlers as unknown as { finals: string[] }).finals).toEqual(['First part.', 'And the tail.']);
    // Summed across segments, not the maximum of them: each completed event
    // reports only its own duration.
    expect(usage.quantity).toBe(7);
    expect(usage.unit).toBe('audio_seconds');
    expect(usage.model).toBe('gpt-transcribe');
    expect(usage.costUsd).toBeCloseTo(7 * (0.0045 / 60), 10);
  });

  it('settles when the commit is refused because nothing was pending', async () => {
    const { stream, socket, handlers } = await openReadySession(true);
    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'All of it already.',
      usage: { type: 'duration', seconds: 2 },
    });

    const settled = stream.end();
    socket.deliver({
      type: 'error',
      error: { message: 'Error committing input audio buffer: buffer too small.' },
    });

    const usage = await settled;
    expect(usage.quantity).toBe(2);
    // An empty commit is the expected consequence of stopping cleanly, so it
    // must not surface as a session failure.
    expect((handlers as unknown as { errors: Error[] }).errors).toHaveLength(0);
  });

  it('bills a session that heard nothing at all', async () => {
    const { stream, socket } = await openReadySession(false);
    const settled = stream.end();
    socket.deliver({ type: 'error', error: { message: 'buffer too small' } });
    const usage = await settled;
    expect(usage.quantity).toBe(0);
    expect(usage.costUsd).toBe(0);
  });

  it('surfaces a real error rather than transcribing on regardless', async () => {
    const { socket, handlers } = await openReadySession(true);
    socket.deliver({ type: 'error', error: { message: 'invalid_request_error: bad model' } });
    const errors = (handlers as unknown as { errors: Error[] }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/bad model/);
  });
});
