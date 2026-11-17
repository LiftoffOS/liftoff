// The speaking adapter bills what the vendor reported, on BOTH paths.
//
// The whole-file path used to bill an estimate — one audio token per two
// characters — because the unstreamed response says nothing about what it cost.
// Measured against the live API the real ratio is about 1.35, so every spoken
// reply on a chat surface under-charged by roughly two thirds and could never
// reconcile against an invoice. These tests pin the fix at the seam where it
// went wrong: what reaches `usage` must come from the vendor, not from the text.

jest.mock('../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));

import { openaiTtsProvider } from '../providers/openai-tts';

/**
 * An SSE body shaped like the one the speech endpoint really returns.
 *
 * CRLF, because that is what the vendor sends. An earlier version of this helper
 * used `\n\n` and every test here passed against a parser that could not read a
 * single real response — the fixture agreed with the bug instead of with OpenAI.
 */
function sseBody(events: unknown[], sep = '\r\n\r\n'): string {
  return events.map((e) => `data: ${JSON.stringify(e)}${sep}`).join('') + `data: [DONE]${sep}`;
}

/** Delivered as one chunk per string, so tests can split frames where they like. */
function sseResponseFrom(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function sseResponse(events: unknown[], sep?: string): Response {
  return sseResponseFrom([sseBody(events, sep)]);
}

const audioDelta = (text: string): Record<string, unknown> => ({
  type: 'speech.audio.delta',
  audio: Buffer.from(text).toString('base64'),
});

/** Real counts from a live call: 386 characters produced 520 audio tokens. */
const doneEvent = (inputTokens: number, outputTokens: number): Record<string, unknown> => ({
  type: 'speech.audio.done',
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const input = (over: Partial<Parameters<typeof openaiTtsProvider.synthesizeFile>[0]> = {}) => ({
  text: 'Hello there.',
  voice: 'nova',
  language: undefined,
  signal: new AbortController().signal,
  ...over,
});

describe('synthesizeFile', () => {
  it('BILLS THE REPORTED TOKENS, not the estimate derived from the text', async () => {
    fetchMock.mockResolvedValue(sseResponse([audioDelta('one'), audioDelta('two'), doneEvent(9, 40)]));

    const seen: number[] = [];
    const result = await openaiTtsProvider.synthesizeFile(
      input({ onUsage: (u) => seen.push(u.quantity) }),
    );

    // 'Hello there.' is 12 characters, so the estimate would be 17 tokens.
    expect(openaiTtsProvider.usageFor('Hello there.').quantity).toBe(17);
    expect(result.usage.quantity).toBe(40);
    expect(result.usage.unit).toBe('audio_tokens');
    expect(result.usage.model).toBe('gpt-4o-mini-tts');
    expect(result.usage.costUsd).toBeCloseTo(9 * 0.0000006 + 40 * 0.000012, 12);
    // Reported once, through the same callback the streaming path uses.
    expect(seen).toEqual([40]);
  });

  it('returns the audio assembled from the streamed deltas', async () => {
    fetchMock.mockResolvedValue(sseResponse([audioDelta('abc'), audioDelta('def'), doneEvent(1, 2)]));
    const result = await openaiTtsProvider.synthesizeFile(input());
    expect(result.audio.toString()).toBe('abcdef');
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('asks for a streamed MP3, because the plain body reports no usage', async () => {
    fetchMock.mockResolvedValue(sseResponse([audioDelta('x'), doneEvent(1, 2)]));
    await openaiTtsProvider.synthesizeFile(input());

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      response_format: string;
      stream_format: string;
      model: string;
    };
    expect(body.response_format).toBe('mp3');
    expect(body.stream_format).toBe('sse');
    expect(body.model).toBe('gpt-4o-mini-tts');
  });

  it('reports zero rather than an invented number when the vendor never said', async () => {
    // A response that ended without a done event is not free, but guessing is
    // how a ledger stops reconciling. Nothing known, nothing claimed.
    fetchMock.mockResolvedValue(sseResponse([audioDelta('x')]));
    const result = await openaiTtsProvider.synthesizeFile(input());
    expect(result.usage.quantity).toBe(0);
    expect(result.usage.costUsd).toBe(0);
  });
});

describe('SSE framing', () => {
  it('READS THE CRLF FRAMING THE VENDOR ACTUALLY SENDS', async () => {
    // Checked against a live response: 54 KB, seventy-five frames, zero
    // occurrences of "\n\n". A parser that split on that alone buffered the whole
    // stream, yielded no audio and reported no usage — while the request
    // succeeded and nothing threw.
    fetchMock.mockResolvedValue(sseResponse([audioDelta('crlf'), doneEvent(1, 9)], '\r\n\r\n'));
    const result = await openaiTtsProvider.synthesizeFile(input());
    expect(result.audio.toString()).toBe('crlf');
    expect(result.usage.quantity).toBe(9);
  });

  it('still reads bare LF, which the spec also allows', async () => {
    fetchMock.mockResolvedValue(sseResponse([audioDelta('lf'), doneEvent(1, 4)], '\n\n'));
    const result = await openaiTtsProvider.synthesizeFile(input());
    expect(result.audio.toString()).toBe('lf');
    expect(result.usage.quantity).toBe(4);
  });

  it('reassembles a frame split across network chunks', async () => {
    // One delta of base64 audio runs to tens of kilobytes, so a frame is
    // routinely larger than a single chunk — the first live chunk was 139 bytes
    // and contained no boundary at all.
    const whole = sseBody([audioDelta('split-across-chunks'), doneEvent(2, 11)]);
    const cut = Math.floor(whole.length / 3);
    fetchMock.mockResolvedValue(
      sseResponseFrom([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)]),
    );

    const result = await openaiTtsProvider.synthesizeFile(input());
    expect(result.audio.toString()).toBe('split-across-chunks');
    expect(result.usage.quantity).toBe(11);
  });
});

describe('synthesize', () => {
  it('streams chunks and reports the vendor tokens once', async () => {
    fetchMock.mockResolvedValue(sseResponse([audioDelta('aa'), audioDelta('bb'), doneEvent(5, 30)]));

    const seen: number[] = [];
    const chunks: Buffer[] = [];
    for await (const chunk of openaiTtsProvider.synthesize(input({ onUsage: (u) => seen.push(u.quantity) }))) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks).toString()).toBe('aabb');
    expect(seen).toEqual([30]);
  });

  it('BARGE-IN STILL BILLS, from the audio that was actually produced', async () => {
    // One second of 24 kHz 16-bit mono, so the floor is a round number.
    const oneSecond = Buffer.alloc(48000).toString('base64');
    const controller = new AbortController();
    fetchMock.mockResolvedValue(
      sseResponse([
        { type: 'speech.audio.delta', audio: oneSecond },
        { type: 'speech.audio.delta', audio: oneSecond },
        doneEvent(5, 30),
      ]),
    );

    const seen: number[] = [];
    for await (const _chunk of openaiTtsProvider.synthesize(
      input({ signal: controller.signal, onUsage: (u) => seen.push(u.quantity) }),
    )) {
      // Barge-in: the listener stopped caring after the first chunk.
      controller.abort();
    }

    // Reporting nothing here is what silently under-charged: the Google adapter
    // bills an interrupted sentence in full, and when the interruption lands on
    // the first sentence `speak-ws` writes no row at all. One second of audio
    // arrived, so ~24 audio tokens is a floor rather than an invention.
    expect(seen).toEqual([24]);
  });

  it('charges nothing when the interruption beat the first byte of audio', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockResolvedValue(sseResponse([audioDelta('aa'), doneEvent(5, 30)]));

    const seen: number[] = [];
    for await (const _chunk of openaiTtsProvider.synthesize(
      input({ signal: controller.signal, onUsage: (u) => seen.push(u.quantity) }),
    )) {
      // no-op: nothing should be produced
    }
    expect(seen).toEqual([]);
  });
});
