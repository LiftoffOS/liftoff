// The pager's four bounds and its continuation cursor.
//
// The cursor is the property worth pinning: a reader paging back through a long
// thread is correct only if the next request starts where this one stopped, and
// the page's own `nextCursor` is the wrong answer whenever a bound stopped the
// walk mid-page. The rest of the thread would be skipped, silently, and the
// model would report the fact absent.

jest.mock('../../common/redact', () => ({
  redactSensitiveText: (text: string) => text.replace(/SECRET/g, '[redacted]'),
}));

import { collectTranscript } from '../transcript';

interface Row { content: string; createdAt: string; kind?: string }

/** A thread, newest first, served through the repositories' cursor contract:
 *  `created_at < cursor`, `limit + 1` probes for `hasMore`. */
function pagerOf(rows: Row[], pageSize = 2) {
  const newestFirst = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const calls: Array<string | undefined> = [];
  const page = async (cursor: string | undefined) => {
    calls.push(cursor);
    const eligible = cursor ? newestFirst.filter((r) => r.createdAt < cursor) : newestFirst;
    const slice = eligible.slice(0, pageSize);
    const hasMore = eligible.length > pageSize;
    return {
      messages: slice,
      hasMore,
      nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1].createdAt : null,
    };
  };
  return { page, calls };
}

/** Strictly increasing timestamps: the walk is newest-first, so a fixture whose
 *  order does not match its numbering tests nothing about the walk. */
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
function at(i: number): string {
  return new Date(T0 + i * 3_600_000).toISOString();
}

function rows(n: number, text = 'hello'): Row[] {
  return Array.from({ length: n }, (_, i) => ({ content: `${text} ${i + 1}`, createdAt: at(i) }));
}

const speaker = (r: Row) => (r.kind === 'status' ? null : 'Person');
const noAttachments = () => [];

describe('collectTranscript', () => {
  it('returns oldest first and reaches the start of a short thread', async () => {
    const { page } = pagerOf(rows(3));
    const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000 });

    expect(out.messages.map((m) => m.text)).toEqual(['hello 1', 'hello 2', 'hello 3']);
    expect(out.truncated).toBe(false);
    expect(out.nextCursor).toBeNull();
  });

  it('skips a row whose speaker resolves null, and that row costs no budget', async () => {
    const thread: Row[] = [
      { content: 'said', createdAt: '2026-09-01T00:00:00.000Z' },
      { content: 'Waiting on an approval', createdAt: '2026-09-02T00:00:00.000Z', kind: 'status' },
      { content: 'also said', createdAt: '2026-09-03T00:00:00.000Z' },
    ];
    const { page } = pagerOf(thread);
    const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000 });

    expect(out.messages.map((m) => m.text)).toEqual(['said', 'also said']);
  });

  it('awaits an asynchronous speaker resolver', async () => {
    const { page } = pagerOf(rows(2));
    const out = await collectTranscript(
      page,
      async (r: Row) => (r.content.endsWith('1') ? 'Ada' : 'agent'),
      noAttachments,
      { charBudget: 10_000 },
    );

    expect(out.messages.map((m) => m.speaker)).toEqual(['Ada', 'agent']);
  });

  it('redacts before the budget is counted and before the match is applied', async () => {
    const { page } = pagerOf([{ content: 'the SECRET value', createdAt: '2026-09-01T00:00:00.000Z' }]);
    const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000 });

    expect(out.messages[0].text).toBe('the [redacted] value');
  });

  describe('the continuation cursor', () => {
    it('is the oldest CONSUMED message, not the page boundary, when a bound stops the walk mid-page', async () => {
      // Pages of 5; the limit stops after 3, so the page's own nextCursor would
      // skip messages 4 and 5 of that page on the next read.
      const thread = rows(10);
      const { page } = pagerOf(thread, 5);
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000, limit: 3 });

      expect(out.messages).toHaveLength(3);
      expect(out.truncated).toBe(true);
      const oldestReturned = out.messages[0];
      expect(out.nextCursor).toBe(oldestReturned.at);
    });

    it('continues exactly where the previous read stopped, losing nothing', async () => {
      const thread = rows(6);
      const { page } = pagerOf(thread, 5);

      const first = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000, limit: 2 });
      const second = await collectTranscript(page, speaker, noAttachments, {
        charBudget: 10_000,
        limit: 2,
        cursor: first.nextCursor!,
      });

      const seen = [...second.messages, ...first.messages].map((m) => m.text);
      // Newest two, then the next two older — contiguous, no gap.
      expect(seen).toEqual(['hello 3', 'hello 4', 'hello 5', 'hello 6']);
    });

    it('is null when the walk reached the start of the thread', async () => {
      const { page } = pagerOf(rows(2));
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000, limit: 50 });

      expect(out.truncated).toBe(false);
      expect(out.nextCursor).toBeNull();
    });
  });

  describe('the character budget', () => {
    it('stops on it and keeps the newest', async () => {
      const { page } = pagerOf(rows(10));
      // 'hello N' is 7 characters; 20 admits two and stops on the third.
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 20 });

      expect(out.messages.map((m) => m.text)).toEqual(['hello 9', 'hello 10']);
      expect(out.truncated).toBe(true);
    });

    it('returns a single message that alone exceeds the whole budget', async () => {
      const { page } = pagerOf([{ content: 'x'.repeat(500), createdAt: '2026-09-01T00:00:00.000Z' }]);
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10 });

      expect(out.messages).toHaveLength(1);
      expect(out.messages[0].text).toHaveLength(500);
    });
  });

  describe('match', () => {
    it('keeps only the matching messages, case-insensitively', async () => {
      const thread: Row[] = [
        { content: 'the Deadline is March', createdAt: '2026-09-01T00:00:00.000Z' },
        { content: 'unrelated chatter', createdAt: '2026-09-02T00:00:00.000Z' },
        { content: 'about the deadline again', createdAt: '2026-09-03T00:00:00.000Z' },
      ];
      const { page } = pagerOf(thread);
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 10_000, match: 'DEADLINE' });

      expect(out.messages.map((m) => m.text)).toEqual(['the Deadline is March', 'about the deadline again']);
    });

    it('reaches further back than an unfiltered read of the same budget, because a filtered row costs nothing', async () => {
      const thread: Row[] = [
        { content: 'the deadline is March', createdAt: '2026-09-01T00:00:00.000Z' },
        ...rows(20, 'noise').map((r, i) => ({ ...r, createdAt: at(i + 100) })),
      ];
      const { page } = pagerOf(thread, 5);
      const out = await collectTranscript(page, speaker, noAttachments, { charBudget: 40, match: 'deadline' });

      expect(out.messages.map((m) => m.text)).toEqual(['the deadline is March']);
      expect(out.truncated).toBe(false);
    });
  });
});
