// The export's ceilings, enforced while collecting rather than after.
//
// The archive is assembled in memory (JSON strings, then the zip buffer), so
// the bound has to hold BEFORE the rows are held, not once they are counted.
// One budget is threaded through every collector, which run sequentially:
// each local query asks for at most `recordsLeft + 1` rows, each remote page
// likewise, and every row accepted is charged one record and its
// pretty-printed UTF-8 size. The first row that would exceed either bound
// throws, so eleven sections can never load eleven times the ceiling before
// the 413. Prod's largest workspace is under 1 MB; the path forward if a
// workspace ever reaches a ceiling is the existing export_jobs + bucket flow
// in data-management/, not a bigger buffer.

/** Records across every section of one export. */
export const RECORD_CEILING = 100_000;

/** Uncompressed JSON bytes, plus the bytes of every produced file. */
export const BYTE_CEILING = 100 * 1024 * 1024;

export type ExportSource = 'tenant_runtime' | 'workforce' | 'connectors';

export class ExportTooLargeError extends Error {
  constructor() {
    super('The workspace holds more than this export can carry');
    this.name = 'ExportTooLargeError';
  }
}

export class ExportSourceUnavailableError extends Error {
  readonly source: ExportSource;
  constructor(source: ExportSource, cause?: unknown) {
    super(`Export source unavailable: ${source}`);
    this.name = 'ExportSourceUnavailableError';
    this.source = source;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export class ExportBudget {
  recordsLeft: number;
  bytesLeft: number;

  constructor(records = RECORD_CEILING, bytes = BYTE_CEILING) {
    this.recordsLeft = records;
    this.bytesLeft = bytes;
  }

  /** `LIMIT LEAST($pageSize, recordsLeft + 1)`: one more than the budget, so
   *  the row that crosses the ceiling is fetched, charged, and refused. */
  pageLimit(pageSize: number): number {
    return Math.max(1, Math.min(pageSize, this.recordsLeft + 1));
  }

  /** One record and its pretty-printed size, or the 413. */
  charge(row: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(row, null, 2) ?? '', 'utf8');
    if (this.recordsLeft - 1 < 0 || this.bytesLeft - bytes < 0) {
      throw new ExportTooLargeError();
    }
    this.recordsLeft -= 1;
    this.bytesLeft -= bytes;
  }

  /** Bytes alone: the produced files' sizes, charged before any is fetched. */
  chargeBytes(bytes: number): void {
    if (this.bytesLeft - bytes < 0) {
      throw new ExportTooLargeError();
    }
    this.bytesLeft -= bytes;
  }
}

/** Rows per remote page; the feeds cap there themselves. */
export const REMOTE_PAGE_SIZE = 200;

/** Wall-clock budget for one remote source, the only real cost of running
 *  the collectors sequentially. */
export const REMOTE_SOURCE_BUDGET_MS = 60_000;

/**
 * Walk one remote feed to the end under the budget.
 *
 * Every page asks for at most `recordsLeft + 1` rows and every row is charged.
 * A NON-ADVANCING `nextCursor` (equal to the cursor just sent) is an error
 * and stops the walk rather than looping; re-sending a valid cursor in a fresh
 * request is ordinary and idempotent, so this is the one shape that can only
 * be a broken source. Any failure, and the per-source wall-clock budget
 * running out, is the source being unavailable: the export has no honest
 * partial answer for a feed it could not finish reading.
 */
export async function walkRemote<T>(
  source: ExportSource,
  budget: ExportBudget,
  fetchPage: (cursor: string | undefined, limit: number) => Promise<{ items: T[]; nextCursor: string | null }>,
  now: () => number = Date.now,
): Promise<T[]> {
  const out: T[] = [];
  const startedAt = now();
  let cursor: string | undefined;
  for (;;) {
    if (now() - startedAt > REMOTE_SOURCE_BUDGET_MS) {
      throw new ExportSourceUnavailableError(source, new Error('per-source time budget exhausted'));
    }
    const limit = Math.max(1, Math.min(REMOTE_PAGE_SIZE, budget.recordsLeft + 1));
    let page: { items: T[]; nextCursor: string | null };
    try {
      page = await fetchPage(cursor, limit);
    } catch (err) {
      throw new ExportSourceUnavailableError(source, err);
    }
    for (const item of page.items) {
      budget.charge(item);
      out.push(item);
    }
    if (page.nextCursor === null) return out;
    if (page.nextCursor === cursor) {
      throw new ExportSourceUnavailableError(source, new Error('feed cursor did not advance'));
    }
    cursor = page.nextCursor;
  }
}
