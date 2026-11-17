// The streaming adapter's contract: interims arrive while someone is still
// speaking, finals settle, and the session reports what the vendor billed even
// when it heard nothing.

import { EventEmitter } from 'node:events';

class FakeRecognizeStream extends EventEmitter {
  written: unknown[] = [];
  ended = false;
  destroyed = false;

  write(message: unknown): void {
    // The real stream raises rather than silently accepting, which is what
    // turned one dead upstream into an error per audio frame.
    if (this.destroyed) throw new Error('Cannot call write after a stream was destroyed');
    this.written.push(message);
  }

  end(): void {
    this.ended = true;
    // The real stream emits 'end' asynchronously after the server closes it.
    setImmediate(() => this.emit('end'));
  }

  /** The upstream going away by itself — a rotation, or a failure. */
  die(err?: Error): void {
    this.destroyed = true;
    if (err) this.emit('error', err);
    else this.emit('end');
  }
}

/** Every upstream opened during a test, in order. Rotation appends. */
let streams: FakeRecognizeStream[] = [];
let fakeStream: FakeRecognizeStream;
const mockStreamingRecognize = jest.fn(() => {
  const next = new FakeRecognizeStream();
  streams.push(next);
  fakeStream = next;
  return next;
});

jest.mock('@google-cloud/speech', () => ({
  v2: {
    SpeechClient: jest.fn().mockImplementation(() => ({
      _streamingRecognize: mockStreamingRecognize,
    })),
  },
}));

import {
  googleSttProvider,
  _billedSeconds,
  _resetGoogleSttClientForTesting,
} from '../providers/google-stt';
import type { SttStreamHandlers } from '../types';

function handlers(): SttStreamHandlers & {
  interims: string[];
  finals: string[];
  errors: Error[];
} {
  const interims: string[] = [];
  const finals: string[] = [];
  const errors: Error[] = [];
  return {
    interims,
    finals,
    errors,
    onInterim: (t) => interims.push(t),
    onFinal: (t) => finals.push(t),
    onError: (e) => errors.push(e),
  };
}

describe('google-stt streaming adapter', () => {
  beforeEach(() => {
    streams = [];
    mockStreamingRecognize.mockClear();
    _resetGoogleSttClientForTesting();
    process.env.GCP_PROJECT_ID = 'test-project';
  });

  const input = { sampleRateHertz: 48000, language: undefined };

  describe('opening the stream', () => {
    it('configures LINEAR16 at the client rate, with interim results on', () => {
      googleSttProvider.openStream(input, handlers());

      const config = fakeStream.written[0] as {
        recognizer: string;
        streamingConfig: {
          config: { explicitDecodingConfig: unknown; model: string };
          streamingFeatures: { interimResults: boolean };
        };
      };
      expect(config.recognizer).toBe('projects/test-project/locations/global/recognizers/_');
      expect(config.streamingConfig.config.explicitDecodingConfig).toEqual({
        // Raw PCM, because a container cannot be streamed frame by frame —
        // only its first chunk carries the headers a decoder needs.
        encoding: 'LINEAR16',
        sampleRateHertz: 48000,
        audioChannelCount: 1,
      });
      // Without this the composer would stay blank until the speaker stopped,
      // which is the behaviour this replaced.
      expect(config.streamingConfig.streamingFeatures.interimResults).toBe(true);
      expect(config.streamingConfig.config.model).toBe('long');
    });

    it('declares both modes, because it serves both', () => {
      // Streaming for someone speaking now; batch for a voice memo that was
      // already finished when it reached us.
      expect(googleSttProvider.capabilities.streaming).toBe(true);
      expect(googleSttProvider.capabilities.batch).toBe(true);
    });

    it('rejects a rate outside what Cloud STT accepts', () => {
      expect(() =>
        googleSttProvider.openStream({ ...input, sampleRateHertz: 96000 }, handlers()),
      ).toThrow(/accepts 8000-48000 Hz/);
    });

    it('fails loudly when the project id is missing', () => {
      delete process.env.GCP_PROJECT_ID;
      expect(() => googleSttProvider.openStream(input, handlers())).toThrow(/GCP_PROJECT_ID/);
    });
  });

  describe('results', () => {
    it('routes interim and final transcripts to their own callbacks', () => {
      const h = handlers();
      googleSttProvider.openStream(input, h);

      fakeStream.emit('data', {
        results: [{ alternatives: [{ transcript: 'testing test' }], isFinal: false }],
      });
      fakeStream.emit('data', {
        results: [{ alternatives: [{ transcript: 'testing testing one two' }], isFinal: true }],
      });

      expect(h.interims).toEqual(['testing test']);
      expect(h.finals).toEqual(['testing testing one two']);
    });

    it('ignores empty alternatives rather than emitting blank interims', () => {
      const h = handlers();
      googleSttProvider.openStream(input, h);
      fakeStream.emit('data', { results: [{ alternatives: [{ transcript: '   ' }] }] });
      expect(h.interims).toEqual([]);
    });

    it('ignores an error from an upstream it has already replaced', () => {
      const h = handlers();
      const session = googleSttProvider.openStream(input, h);
      const first = streams[0] as FakeRecognizeStream;
      first.die(new Error('rotated'));
      // The replaced stream coughing again must not be mistaken for the live
      // one failing.
      first.emit('error', new Error('late noise'));
      session.write(Buffer.from([1, 2]));
      expect(h.errors).toEqual([]);
    });
  });

  // Cloud STT ends a recognition stream routinely — at its own five-minute
  // ceiling, and on a voice-activity timeout. Treating that as the end of the
  // session is what made a conversation die and the microphone disarm.
  describe('surviving the upstream', () => {
    it('opens a replacement when the upstream ends, and keeps transcribing', () => {
      const h = handlers();
      const session = googleSttProvider.openStream(input, h);
      expect(streams).toHaveLength(1);

      (streams[0] as FakeRecognizeStream).die();
      expect(streams).toHaveLength(2);
      // The replacement is configured like the original, not left bare.
      expect((streams[1] as FakeRecognizeStream).written).toHaveLength(1);

      session.write(Buffer.from([1, 2, 3]));
      (streams[1] as FakeRecognizeStream).emit('data', {
        results: [{ alternatives: [{ transcript: 'still here' }], isFinal: true }],
      });
      expect(h.finals).toEqual(['still here']);
      expect(h.errors).toEqual([]);
    });

    it('never writes into a dead upstream', () => {
      const h = handlers();
      const session = googleSttProvider.openStream(input, h);
      const first = streams[0] as FakeRecognizeStream;
      first.destroyed = true;

      // One dead stream used to raise one error PER FRAME — hundreds in a
      // couple of milliseconds, which is what closed the socket.
      for (let i = 0; i < 50; i++) session.write(Buffer.from([i]));
      expect(h.errors).toEqual([]);
    });

    it('gives up when replacements keep dying immediately', () => {
      const h = handlers();
      googleSttProvider.openStream(input, h);
      // A config or permission fault cannot be rotated away, and retrying it
      // forever would bill for nothing.
      for (let i = 0; i < 3; i++) {
        (streams[streams.length - 1] as FakeRecognizeStream).die(new Error('PERMISSION_DENIED'));
      }
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]?.message).toMatch(/PERMISSION_DENIED/);
    });

    it('bills every segment, not just the last one', async () => {
      const h = handlers();
      const session = googleSttProvider.openStream(input, h);

      // Duration is cumulative WITHIN one upstream and restarts with the next,
      // so a rotated session that only reported the final stream would
      // under-bill by everything said before the rotation.
      (streams[0] as FakeRecognizeStream).emit('data', {
        metadata: { totalBilledDuration: { seconds: 8, nanos: 0 } },
      });
      (streams[0] as FakeRecognizeStream).die();
      (streams[1] as FakeRecognizeStream).emit('data', {
        metadata: { totalBilledDuration: { seconds: 5, nanos: 0 } },
      });

      const usage = await session.end();
      expect(usage.quantity).toBeCloseTo(13, 6);
    });
  });

  describe('audio', () => {
    it('forwards frames as audio messages', () => {
      const stream = googleSttProvider.openStream(input, handlers());
      stream.write(Buffer.from([1, 2, 3, 4]));
      expect(fakeStream.written[1]).toEqual({ audio: Buffer.from([1, 2, 3, 4]) });
    });

    it('drops frames arriving after the session ended', async () => {
      const stream = googleSttProvider.openStream(input, handlers());
      const done = stream.end();
      stream.write(Buffer.from([9]));
      await done;
      // Only the config message was ever written.
      expect(fakeStream.written).toHaveLength(1);
    });
  });

  describe('billing', () => {
    it('reports the largest duration the stream reported, not a sum', async () => {
      const stream = googleSttProvider.openStream(input, handlers());
      // Duration is cumulative across responses; summing would over-bill.
      fakeStream.emit('data', { metadata: { totalBilledDuration: { seconds: 2 } }, results: [] });
      fakeStream.emit('data', { metadata: { totalBilledDuration: { seconds: 5 } }, results: [] });

      const usage = await stream.end();

      expect(usage.quantity).toBe(5);
      expect(usage.unit).toBe('audio_seconds');
      expect(usage.model).toBe('long');
      expect(usage.costUsd).toBeCloseTo(5 * (0.016 / 60), 10);
    });

    it('still settles when the vendor billed nothing', async () => {
      const stream = googleSttProvider.openStream(input, handlers());
      const usage = await stream.end();
      expect(usage.quantity).toBe(0);
      expect(usage.costUsd).toBe(0);
    });

    it('settles even if the upstream errors instead of closing cleanly', async () => {
      const stream = googleSttProvider.openStream(input, handlers());
      fakeStream.emit('data', { metadata: { totalBilledDuration: { seconds: 3 } }, results: [] });
      const done = stream.end();
      fakeStream.emit('error', new Error('closed rudely'));
      // A stuck upstream must not hold the ledger write hostage.
      await expect(done).resolves.toMatchObject({ quantity: 3 });
    });

    it('reads seconds and nanos, including string-encoded seconds', () => {
      expect(_billedSeconds({ seconds: 2, nanos: 250_000_000 })).toBe(2.25);
      expect(_billedSeconds({ seconds: '4' as unknown as number, nanos: 0 })).toBe(4);
      expect(_billedSeconds(null)).toBe(0);
      expect(_billedSeconds(undefined)).toBe(0);
    });
  });
});
