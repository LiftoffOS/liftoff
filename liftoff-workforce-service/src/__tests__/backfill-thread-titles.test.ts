// The one-shot title backfill.
//
// This sweep writes to threads across every tenant, so the properties worth
// pinning are the ones that make that safe and the one that makes it useful:
// it runs the same generator a live turn runs, it reads and writes inside
// withTenantContext, it feeds the generator the first real exchange, and one
// bad thread does not end the run.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPoolQuery = jest.fn();
jest.mock('../infrastructure/database.js', () => ({
  getPool: () => ({ query: mockPoolQuery, end: jest.fn() }),
}));

const mockClientQuery = jest.fn();
const mockWithTenantContext = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    mockWithTenantContext(tenantId, fn),
}));

const mockUpdateThreadTitleInternal = jest.fn();
jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  updateThreadTitleInternal: (...a: unknown[]) => mockUpdateThreadTitleInternal(...a),
}));

const mockMaybeGenerateThreadTitle = jest.fn();
jest.mock('../workforce-plans/thread-title.js', () => ({
  maybeGenerateThreadTitle: (...a: unknown[]) => mockMaybeGenerateThreadTitle(...a),
}));

import { backfillThreadTitles } from '../scripts/backfill-thread-titles.js';

const TENANT_A = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const THREAD_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THREAD_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function candidates(...rows: Array<{ thread_id: string; tenant_id: string }>) {
  mockPoolQuery.mockResolvedValue({ rows });
}

function messages(rows: Array<{ role: string; content: string }>) {
  mockClientQuery.mockResolvedValue({ rows });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWithTenantContext.mockImplementation((_tenantId, fn) => fn({ query: mockClientQuery }));
  mockMaybeGenerateThreadTitle.mockResolvedValue(undefined);
});

describe('backfillThreadTitles', () => {
  it('enumerates through the SECURITY DEFINER function, not a raw table read', async () => {
    // A cross-tenant sweep on a raw pool would match zero rows under RLS and
    // report a clean run — a silent failure that looks like success.
    candidates();
    await backfillThreadTitles({ limit: 500, dryRun: false });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('workforce_find_untitled_plan_threads');
    expect(sql).not.toMatch(/FROM\s+team_plan_threads/i);
    expect(params).toEqual([500]);
  });

  it('titles a thread with the same generator a live turn uses, scoped to its tenant', async () => {
    candidates({ thread_id: THREAD_A, tenant_id: TENANT_A });
    messages([
      { role: 'assistant', content: 'Hi, I am your Chief AI Officer.' },
      { role: 'user', content: 'we process about 10 donor grant recommendations a month' },
      { role: 'assistant', content: 'Tell me how they arrive.' },
    ]);

    const result = await backfillThreadTitles({ limit: 500, dryRun: false });

    expect(mockWithTenantContext).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    const call = mockMaybeGenerateThreadTitle.mock.calls[0][0];
    // The greeting precedes the user's message and must not become the title.
    expect(call.userMessage).toBe('we process about 10 donor grant recommendations a month');
    expect(call.assistantMessage).toBe('Tell me how they arrive.');
    expect(call.tenantId).toBe(TENANT_A);
    // Persistence goes through the repository's tenant-scoped writer, which is
    // what refuses to overwrite a title someone set by hand.
    await call.updateTitle(THREAD_A, TENANT_A, 'Donor grant intake');
    expect(mockUpdateThreadTitleInternal).toHaveBeenCalledWith(
      THREAD_A, TENANT_A, 'Donor grant intake',
    );
    expect(call.purpose).toBe('caio_workforce_planning_title_generation');
    expect(result).toEqual({ candidates: 1, titled: 1, skipped: 0, failed: 0 });
  });

  it('skips a thread whose turn failed at the time, leaving no reply to title from', async () => {
    candidates({ thread_id: THREAD_A, tenant_id: TENANT_A });
    messages([
      { role: 'assistant', content: 'Hi, I am your Chief AI Officer.' },
      { role: 'user', content: 'help me plan a team' },
    ]);

    const result = await backfillThreadTitles({ limit: 500, dryRun: false });

    expect(mockMaybeGenerateThreadTitle).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, titled: 0, skipped: 1, failed: 0 });
  });

  it('keeps going when one thread fails, and leaves it a candidate for the next run', async () => {
    candidates(
      { thread_id: THREAD_A, tenant_id: TENANT_A },
      { thread_id: THREAD_B, tenant_id: TENANT_B },
    );
    messages([
      { role: 'user', content: 'plan a team' },
      { role: 'assistant', content: 'Sure.' },
    ]);
    mockMaybeGenerateThreadTitle
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce(undefined);

    const result = await backfillThreadTitles({ limit: 500, dryRun: false });

    expect(result).toEqual({ candidates: 2, titled: 1, skipped: 0, failed: 1 });
    expect(mockWithTenantContext).toHaveBeenCalledWith(TENANT_B, expect.any(Function));
  });

  it('calls no model and writes nothing on a dry run', async () => {
    candidates({ thread_id: THREAD_A, tenant_id: TENANT_A });
    messages([
      { role: 'user', content: 'plan a team' },
      { role: 'assistant', content: 'Sure.' },
    ]);

    const result = await backfillThreadTitles({ limit: 500, dryRun: true });

    expect(mockMaybeGenerateThreadTitle).not.toHaveBeenCalled();
    expect(mockUpdateThreadTitleInternal).not.toHaveBeenCalled();
    expect(result.titled).toBe(1);
  });

  it('ignores whitespace-only messages when looking for the first real exchange', async () => {
    candidates({ thread_id: THREAD_A, tenant_id: TENANT_A });
    messages([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'we run a donor advised fund' },
      { role: 'assistant', content: 'How many grants a month?' },
    ]);

    await backfillThreadTitles({ limit: 500, dryRun: false });

    const call = mockMaybeGenerateThreadTitle.mock.calls[0][0];
    expect(call.userMessage).toBe('we run a donor advised fund');
    expect(call.assistantMessage).toBe('How many grants a month?');
  });
});
