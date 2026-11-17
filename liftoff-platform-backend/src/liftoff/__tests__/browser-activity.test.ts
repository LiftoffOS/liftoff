// The browser-activity trail's fallback writer and permanent reader.
//
// The properties that carry it: the row is written under the call's own id
// and only once; instruction and outcome are sanitized and truncated with
// explicit markers, never rejected; a takeover is recognised by the runtime's
// exact refusal sentence and nothing else (page content must not be able to
// fake one); the writer never throws into the turn; and the instruction is
// pulled from the input by tool shape, through the sanitizer.

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  listBrowserActivityPage,
  recordBrowserActivity,
  PROTECTED_DATA_OMITTED_MARKER,
  TRUNCATED_MARKER,
} from '../browser-activity';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const THREAD = '00000000-0000-0000-0000-0000000000cc';
const ID = '00000000-0000-0000-0000-0000000000dd';
/** A safe instruction as the boundary sanitizer carries it, unchanged. */
const plain = (text: string) => ({ text, truncated: false, protectedDataOmitted: false });

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('recordBrowserActivity', () => {
  it('writes under the call\'s id, once: a second write of the same id does nothing', async () => {
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: plain('Export the CSV'), outcome: 'done', steps: null,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO liftoff_browser_activity\s+\(id, tenant_id, thread_id, tool, instruction, outcome, person_took_over, steps\)/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(params[0]).toBe(ID);
  });

  it('truncates rather than rejecting an over-long step, reserving space for the explicit marker inside the cap', async () => {
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: { text: 'x'.repeat(5000), truncated: true, protectedDataOmitted: false },
      outcome: 'y'.repeat(5000),
      steps: null,
    });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    const instruction = params[4] as string;
    const outcome = params[5] as string;
    expect(instruction.length).toBe(2000);
    expect(instruction.endsWith(' ' + TRUNCATED_MARKER)).toBe(true);
    expect(outcome.length).toBe(1000);
    expect(outcome.endsWith(' ' + TRUNCATED_MARKER)).toBe(true);
  });

  it('stores only safe text, with the protected-data marker when the sanitizer removed something', async () => {
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: { text: 'sign in with password=[redacted]', truncated: false, protectedDataOmitted: true },
      outcome: 'Signed in with password=hunter2 to https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c',
      steps: null,
    });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe('sign in with password=[redacted] ' + PROTECTED_DATA_OMITTED_MARKER);
    expect(params[5]).toBe('Signed in with password=[redacted] to https://a.example/reset-password/[redacted] ' + PROTECTED_DATA_OMITTED_MARKER);
    expect(JSON.stringify(params)).not.toMatch(/hunter2|3f2a91b8c07d4e659a1b0d3e5f7a9b1c/);
  });

  it('marks a takeover only on the runtime refusal sentence, not on page content', async () => {
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: plain('Check the incident page'),
      outcome: 'The user has taken over this browser session. Wait for them to release control before issuing further browser actions.',
      steps: null,
    });
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: plain('Check the incident page'),
      // A success result whose CONTENT happens to contain the phrase.
      outcome: 'The browser finished. What it reported: the incident ticket was taken over by the night shift.',
      steps: null,
    });
    expect((query.mock.calls[0][1] as unknown[])[6]).toBe(true);
    expect((query.mock.calls[1][1] as unknown[])[6]).toBe(false);
  });

  it('writes the steps as given, whole, and null when the tool reported none', async () => {
    const flags = { actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null };
    const steps = [
      { type: 'goto', action: 'https://a.example/login', pageUrl: '', ...flags },
      { type: 'act', action: 'fill · the password field · (authentication value not recorded)', pageUrl: 'https://a.example/login', ...flags, protectedDataOmitted: true, protectedKind: 'authentication' },
    ];
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: plain('Sign in'), outcome: 'Signed in', steps,
    });
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task',
      instruction: plain('Sign in'), outcome: 'Signed in', steps: [],
    });
    await recordBrowserActivity({
      id: ID, tenantId: TENANT, threadId: THREAD, tool: 'navigate_browser_session',
      instruction: plain('https://a.example'), outcome: 'ok', steps: null,
    });
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/person_took_over, steps\)/);
    expect((query.mock.calls[0][1] as unknown[])[7]).toBe(JSON.stringify(steps));
    // A loop that took none is [] and a tool that reported none is null: the
    // two are different answers and stay different.
    expect((query.mock.calls[1][1] as unknown[])[7]).toBe('[]');
    expect((query.mock.calls[2][1] as unknown[])[7]).toBeNull();
  });

  it('never throws into the turn', async () => {
    query.mockRejectedValue(new Error('db went away'));
    await expect(
      recordBrowserActivity({
        id: ID, tenantId: TENANT, threadId: THREAD, tool: 'navigate_browser_session',
        instruction: plain('https://a.example'), outcome: 'ok', steps: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('listBrowserActivityPage', () => {
  const ROW_ID = '00000000-0000-0000-0000-0000000000e1';

  it('reads one page newest first on (created_at, id), one past the limit, and maps the rows', async () => {
    query.mockResolvedValue({
      rows: [{
        id: ROW_ID,
        tool: 'run_browser_task',
        instruction: 'Export the CSV',
        outcome: 'The browser finished the task.',
        person_took_over: false,
        steps: [{ type: 'act', action: 'click Export', pageUrl: 'https://a.example/reports' }],
        created_at: new Date('2026-09-01T00:00:00Z'),
      }],
    });
    const page = await listBrowserActivityPage(TENANT, THREAD, { limit: 50 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql).toMatch(/\(created_at, id\) < \(\$2::timestamptz, \$3::uuid\)/);
    expect(params).toEqual([THREAD, null, null, 51]);
    expect(page.hasMore).toBe(false);
    expect(page.rows).toEqual([{
      id: ROW_ID,
      tool: 'run_browser_task',
      instruction: 'Export the CSV',
      outcome: 'The browser finished the task.',
      personTookOver: false,
      // A step written before the completeness flags existed reads with them
      // false and no time.
      steps: [{
        type: 'act', action: 'click Export', pageUrl: 'https://a.example/reports',
        actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null,
      }],
      createdAt: '2026-09-01T00:00:00.000Z',
    }]);
  });

  it('passes the cursor and reports an older page from the extra row', async () => {
    query.mockResolvedValue({
      rows: [
        { id: 'r2', tool: 't', instruction: '', outcome: '', person_took_over: false, steps: null, created_at: new Date('2026-09-01T00:00:02Z') },
        { id: 'r1', tool: 't', instruction: '', outcome: '', person_took_over: false, steps: null, created_at: new Date('2026-09-01T00:00:01Z') },
      ],
    });
    const page = await listBrowserActivityPage(TENANT, THREAD, {
      limit: 1, before: { createdAt: '2026-09-01T00:00:03.000Z', id: ROW_ID },
    });
    expect((query.mock.calls[0][1] as unknown[])).toEqual([THREAD, '2026-09-01T00:00:03.000Z', ROW_ID, 2]);
    expect(page.hasMore).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].steps).toBeNull();
  });

  it('reads a malformed steps column as none rather than trusting it', async () => {
    query.mockResolvedValue({
      rows: [{ id: 'r', tool: 't', instruction: '', outcome: '', person_took_over: false, steps: { not: 'a list' }, created_at: new Date() }],
    });
    const page = await listBrowserActivityPage(TENANT, THREAD, { limit: 5 });
    expect(page.rows[0].steps).toBeNull();
  });
});
