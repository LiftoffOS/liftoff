// The ceilings are enforced while collecting: every row charged, the first
// row past either bound refused, and no more than ceiling + page size rows
// ever fetched however many sections there are.

import {
  ExportBudget,
  ExportTooLargeError,
  ExportSourceUnavailableError,
  walkRemote,
  REMOTE_PAGE_SIZE,
  REMOTE_SOURCE_BUDGET_MS,
} from '../budget';

describe('ExportBudget', () => {
  it('charges one record and its pretty-printed UTF-8 size per row', () => {
    const budget = new ExportBudget(10, 1000);
    const row = { a: 'é' };
    budget.charge(row);
    expect(budget.recordsLeft).toBe(9);
    expect(budget.bytesLeft).toBe(1000 - Buffer.byteLength(JSON.stringify(row, null, 2), 'utf8'));
  });

  it('throws on the first row that would exceed the record ceiling', () => {
    const budget = new ExportBudget(2, 1_000_000);
    budget.charge({});
    budget.charge({});
    expect(() => budget.charge({})).toThrow(ExportTooLargeError);
  });

  it('throws on the first row that would exceed the byte ceiling', () => {
    const budget = new ExportBudget(1000, 20);
    budget.charge({ a: 1 });
    expect(() => budget.charge({ b: 'a much longer value than fits' })).toThrow(ExportTooLargeError);
  });

  it('asks for LEAST(pageSize, recordsLeft + 1) rows', () => {
    const budget = new ExportBudget(5, 1000);
    expect(budget.pageLimit(1000)).toBe(6);
    expect(budget.pageLimit(3)).toBe(3);
    budget.recordsLeft = 0;
    expect(budget.pageLimit(1000)).toBe(1);
  });

  it('charges file sizes as bytes alone', () => {
    const budget = new ExportBudget(5, 100);
    budget.chargeBytes(60);
    expect(budget.bytesLeft).toBe(40);
    expect(budget.recordsLeft).toBe(5);
    expect(() => budget.chargeBytes(41)).toThrow(ExportTooLargeError);
  });

  it('eleven sections each just under the ceiling together return 413 after at most ceiling + page rows', () => {
    // Each "section" is a collector that fetches a page of at most
    // pageLimit rows at a time and charges them; the budget stops the
    // eleventh long before it has loaded eleven ceilings.
    const CEILING = 1000;
    const PAGE = 100;
    const budget = new ExportBudget(CEILING, Number.MAX_SAFE_INTEGER);
    let fetched = 0;
    const section = () => {
      let served = 0;
      for (;;) {
        const limit = budget.pageLimit(PAGE);
        const rows = Array.from({ length: Math.min(limit, 999 - served) }, () => ({ x: 1 }));
        fetched += rows.length;
        served += rows.length;
        for (const r of rows) budget.charge(r);
        if (rows.length < limit) return;
      }
    };
    expect(() => { for (let i = 0; i < 11; i += 1) section(); }).toThrow(ExportTooLargeError);
    expect(fetched).toBeLessThanOrEqual(CEILING + PAGE);
  });

  it('the same for bytes: sections legal alone, over the ceiling in aggregate', () => {
    const rowBytes = Buffer.byteLength(JSON.stringify({ x: 'y' }, null, 2), 'utf8');
    const budget = new ExportBudget(Number.MAX_SAFE_INTEGER, rowBytes * 25);
    let charged = 0;
    const section = () => { for (let i = 0; i < 10; i += 1) { budget.charge({ x: 'y' }); charged += 1; } };
    section();
    section();
    expect(() => section()).toThrow(ExportTooLargeError);
    expect(charged).toBe(25);
  });
});

describe('walkRemote', () => {
  it('walks every page, asks for at most recordsLeft + 1 per page, and charges each item', async () => {
    const budget = new ExportBudget(1000, 1_000_000);
    const pages: Record<string, { items: { id: string }[]; nextCursor: string | null }> = {
      first: { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c2' },
      c2: { items: [{ id: 'c' }], nextCursor: null },
    };
    const asked: number[] = [];
    const items = await walkRemote('tenant_runtime', budget, async (cursor, limit) => {
      asked.push(limit);
      return pages[cursor ?? 'first'];
    });
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(asked).toEqual([REMOTE_PAGE_SIZE, REMOTE_PAGE_SIZE]);
    expect(budget.recordsLeft).toBe(997);

    const tight = new ExportBudget(3, 1_000_000);
    const askedTight: number[] = [];
    await walkRemote('tenant_runtime', tight, async (cursor, limit) => {
      askedTight.push(limit);
      return pages[cursor ?? 'first'];
    });
    expect(askedTight).toEqual([4, 2]);
  });

  it('stops with an error, naming the source, when the cursor does not advance', async () => {
    const budget = new ExportBudget(1000, 1_000_000);
    let calls = 0;
    await expect(walkRemote('workforce', budget, async () => {
      calls += 1;
      return { items: [{ id: `x${calls}` }], nextCursor: 'same' };
    })).rejects.toMatchObject({ name: 'ExportSourceUnavailableError', source: 'workforce' });
    // The first page carried no cursor to compare with; the second repeats it.
    expect(calls).toBe(2);
  });

  it('throws the source on a failed fetch and on an exhausted time budget', async () => {
    const budget = new ExportBudget(1000, 1_000_000);
    await expect(walkRemote('tenant_runtime', budget, async () => { throw new Error('ECONNREFUSED'); }))
      .rejects.toBeInstanceOf(ExportSourceUnavailableError);

    let now = 0;
    await expect(walkRemote('workforce', budget, async () => {
      now += REMOTE_SOURCE_BUDGET_MS;
      return { items: [], nextCursor: 'next' };
    }, () => now)).rejects.toMatchObject({ source: 'workforce' });
  });

  it('refuses the row that crosses the record ceiling as 413, not as a source failure', async () => {
    const budget = new ExportBudget(1, 1_000_000);
    await expect(walkRemote('tenant_runtime', budget, async () => ({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: null })))
      .rejects.toBeInstanceOf(ExportTooLargeError);
  });
});
