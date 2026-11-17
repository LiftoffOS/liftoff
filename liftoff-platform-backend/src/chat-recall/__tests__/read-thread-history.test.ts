// What the model actually reads back, and the two refusals.
//
// The rendering is the contract here: a model that cannot tell WHEN something
// was said cannot answer "what did I tell you before the change", and one that
// is not told older messages remain will report a fact absent after reading a
// single page of a long thread.

const mockResolveThread = jest.fn();
const mockCollect = jest.fn();

jest.mock('../surfaces', () => ({
  surfaceReader: () => ({
    surface: 'liftoff',
    counterpart: 'Liftoff',
    tables: { threads: 't', messages: 'm', turns: 'u' },
    resolveThread: (...a: unknown[]) => mockResolveThread(...a),
    collect: (...a: unknown[]) => mockCollect(...a),
  }),
}));

import { readThreadHistory } from '../read-thread-history';

const CTX = { tenantId: 'ten-1', surface: 'liftoff' as const, threadId: 'thr-1' };

function entry(speaker: string, text: string, at: string, attachments: string[] = []) {
  return { speaker, text, at, attachments };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveThread.mockResolvedValue({ id: 'thr-1' });
  mockCollect.mockResolvedValue({ messages: [], truncated: false, nextCursor: null });
});

describe('readThreadHistory', () => {
  it('renders each message with its time and speaker, oldest first', async () => {
    mockCollect.mockResolvedValue({
      messages: [
        entry('Person', 'the deadline is 3 March', '2026-09-01T09:15:00.000Z'),
        entry('Liftoff', 'noted', '2026-09-01T09:16:00.000Z'),
      ],
      truncated: false,
      nextCursor: null,
    });

    const out = await readThreadHistory(CTX, {});

    expect(out).toContain('[2026-09-01 09:15] Person: the deadline is 3 March');
    expect(out).toContain('[2026-09-01 09:16] Liftoff: noted');
    expect(out.indexOf('09:15')).toBeLessThan(out.indexOf('09:16'));
  });

  it('names the attachments a message carried', async () => {
    mockCollect.mockResolvedValue({
      messages: [entry('Person', 'see this', '2026-09-01T09:15:00.000Z', ['Q3 plan (google_drive)'])],
      truncated: false,
      nextCursor: null,
    });

    expect(await readThreadHistory(CTX, {})).toContain('[attached: Q3 plan (google_drive)]');
  });

  it('says older messages remain and hands back the cursor to continue', async () => {
    mockCollect.mockResolvedValue({
      messages: [entry('Person', 'hello', '2026-09-02T10:00:00.000Z')],
      truncated: true,
      nextCursor: '2026-09-02T10:00:00.000Z',
    });

    const out = await readThreadHistory(CTX, {});

    expect(out).toContain('Older messages remain');
    expect(out).toContain('before="2026-09-02T10:00:00.000Z"');
  });

  it('says so when the read reached the start of the conversation', async () => {
    mockCollect.mockResolvedValue({
      messages: [entry('Person', 'hello', '2026-09-02T10:00:00.000Z')],
      truncated: false,
      nextCursor: null,
    });

    const out = await readThreadHistory(CTX, {});

    expect(out).toContain('This reaches the start of the conversation.');
    expect(out).not.toContain('Older messages remain');
  });

  it('distinguishes "nothing earlier" from "nothing matched", so the model does not report a fact absent', async () => {
    expect(await readThreadHistory(CTX, {})).toBe('There is nothing earlier in this conversation.');
    expect(await readThreadHistory(CTX, { match: 'deadline' }))
      .toBe('No earlier message in this conversation contains "deadline".');
  });

  it('refuses a conversation that does not resolve under this tenant, without reading it', async () => {
    mockResolveThread.mockResolvedValue(null);

    expect(await readThreadHistory(CTX, {})).toBe('This conversation could not be read.');
    expect(mockCollect).not.toHaveBeenCalled();
  });

  describe('argument bounds', () => {
    it('clamps limit into 1-100 and defaults when it is not a number', async () => {
      await readThreadHistory(CTX, { limit: 5000 });
      expect(mockCollect.mock.calls[0][2].limit).toBe(100);

      await readThreadHistory(CTX, { limit: 0 });
      expect(mockCollect.mock.calls[1][2].limit).toBe(1);

      await readThreadHistory(CTX, { limit: Number.NaN });
      expect(mockCollect.mock.calls[2][2].limit).toBe(30);
    });

    it('treats a malformed before as "start at the newest" rather than failing the call', async () => {
      await readThreadHistory(CTX, { before: 'last Tuesday' });

      expect(mockCollect.mock.calls[0][2].cursor).toBeUndefined();
    });

    it('normalises a usable before to an ISO instant', async () => {
      await readThreadHistory(CTX, { before: '2026-09-02T10:00:00Z' });

      expect(mockCollect.mock.calls[0][2].cursor).toBe('2026-09-02T10:00:00.000Z');
    });

    it('passes a match through and drops an empty one', async () => {
      await readThreadHistory(CTX, { match: '  deadline  ' });
      expect(mockCollect.mock.calls[0][2].match).toBe('deadline');

      await readThreadHistory(CTX, { match: '   ' });
      expect(mockCollect.mock.calls[1][2].match).toBeUndefined();
    });
  });
});
