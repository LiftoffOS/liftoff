// Defect A regression tests.
//
// Without coverage of runCollabExport and listUngradedSessions, a four-member
// outcome column can meet a three-member schema and stay there unnoticed. GCS is faked in memory; no network, no credentials.

const objects = new Map<string, string>();

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: () => ({
      getFiles: async ({ prefix }: { prefix: string }) => [
        [...objects.keys()]
          .filter((n) => n.startsWith(prefix))
          .sort()
          .map((name) => ({ name, delete: async () => { objects.delete(name); } })),
      ],
      file: (name: string) => ({
        name,
        download: async () => {
          const body = objects.get(name);
          if (body === undefined) throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
          return [Buffer.from(body, 'utf8')];
        },
        save: async (payload: string) => { objects.set(name, payload); },
        delete: async () => { objects.delete(name); },
      }),
    }),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runCollabExport, listUngradedSessions } from '../export';

const BUCKET = 'trajectories-test';
const SESSIONS = 'diagnostics/collab_sessions/';
const MATCHES = 'diagnostics/collab_matches/';

type Row = Record<string, unknown>;

function row(over: Row = {}): Row {
  return {
    session_id: 's1',
    tenant_id: 't1',
    agent_id: 'a1',
    human_id: null,
    provider: 'anthropic',
    model: 'claude',
    outcome: 'success',
    terminal_state: 'success',
    started_at: '2026-08-01T00:00:00.000Z',
    emitted_at: '2026-08-01T00:00:01.000Z',
    source: 'live',
    schema_version: 3,
    ...over,
  };
}

function putSessions(objectKey: string, rows: unknown[]): void {
  objects.set(`${SESSIONS}${objectKey}.ndjson`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function publishedMatches(): Array<Record<string, unknown>> {
  const meta = JSON.parse(objects.get(`${MATCHES}latest.meta.json`)!) as { data_object: string };
  return objects.get(meta.data_object)!
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => objects.clear());

describe('runCollabExport — gated sessions reach the export', () => {
  it('carries a gated row through instead of aborting on it', async () => {
    putSessions('live/s1/2026-08-01T00-00-01-000Z', [
      row({ session_id: 's1', outcome: 'gated', terminal_state: 'gated' }),
    ]);

    const meta = await runCollabExport(BUCKET, 'exp-1', '2026-08-02T00:00:00.000Z');

    expect(meta.row_count).toBe(1);
    const matches = publishedMatches();
    expect(matches[0].outcome).toBe('gated');
    expect(matches[0].sessionId).toBe('s1');
  });

  it('keeps a governance refusal and an approval wait distinguishable', async () => {
    // Both project onto outcome='gated'. terminal_state is the only column that
    // separates them, and the consumer needs it to score them correctly.
    putSessions('live/refused/2026-08-01T00-00-01-000Z', [
      row({ session_id: 'refused', outcome: 'gated', terminal_state: 'gated' }),
    ]);
    putSessions('live/waiting/2026-08-01T00-00-02-000Z', [
      row({ session_id: 'waiting', outcome: 'gated', terminal_state: 'paused', emitted_at: '2026-08-01T00:00:02.000Z' }),
    ]);

    await runCollabExport(BUCKET, 'exp-2', '2026-08-02T00:00:00.000Z');

    const byId = Object.fromEntries(publishedMatches().map((m) => [m.sessionId, m]));
    expect(byId.refused.outcome).toBe('gated');
    expect(byId.refused.terminalState).toBe('gated');
    expect(byId.waiting.outcome).toBe('gated');
    expect(byId.waiting.terminalState).toBe('paused');
  });

  it('accepts a pre-v3 row that carries no terminal_state, as null', async () => {
    const legacy = row({ schema_version: 2 });
    delete legacy.terminal_state;
    putSessions('live/s1', [legacy]);

    await runCollabExport(BUCKET, 'exp-3', '2026-08-02T00:00:00.000Z');

    expect(publishedMatches()[0].terminalState).toBeNull();
  });
});

describe('runCollabExport — a session that emits more than once', () => {
  it('dedupes to the later emitted_at, so the resumed half wins', async () => {
    // The pause emit and the terminal emit after the person acted. Distinct
    // object keys (monotonic, per liveObjectKey), one session on read.
    putSessions('live/s1/2026-08-01T00-00-01-000Z', [
      row({ outcome: 'gated', terminal_state: 'paused', emitted_at: '2026-08-01T00:00:01.000Z' }),
    ]);
    putSessions('live/s1/2026-08-01T09-30-00-000Z', [
      row({ outcome: 'success', terminal_state: 'success', emitted_at: '2026-08-01T09:30:00.000Z' }),
    ]);

    const meta = await runCollabExport(BUCKET, 'exp-4', '2026-08-02T00:00:00.000Z');

    expect(meta.row_count).toBe(1);
    const matches = publishedMatches();
    expect(matches[0].outcome).toBe('success');
    expect(matches[0].terminalState).toBe('success');
    // The watermark advances to the later emit.
    expect(meta.watermark).toBe('2026-08-01T09:30:00.000Z');
  });

  it('prefers a live row over a backfill row even when the backfill is later', async () => {
    putSessions('backfill/bf-1/late', [
      row({ source: 'backfill', outcome: 'error', terminal_state: null, emitted_at: '2026-08-05T00:00:00.000Z' }),
    ]);
    putSessions('live/s1/2026-08-01T00-00-01-000Z', [row({ outcome: 'success' })]);

    await runCollabExport(BUCKET, 'exp-5', '2026-08-06T00:00:00.000Z');

    expect(publishedMatches()[0].outcome).toBe('success');
  });
});

describe('runCollabExport — the skip tolerance', () => {
  it('skips a malformed row and still publishes, when the fraction stays under the ceiling', async () => {
    // Reachable at all only because parse became safeParse: the strict parse
    // threw before `skipped` could ever be incremented.
    const good = Array.from({ length: 200 }, (_, i) =>
      row({ session_id: `s${i}`, emitted_at: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` }));
    putSessions('live/good', good);
    putSessions('live/bad', [{ session_id: 'nope', outcome: 'not-a-real-outcome' }]);

    const meta = await runCollabExport(BUCKET, 'exp-6', '2026-08-02T00:00:00.000Z');

    expect(meta.row_count).toBe(200);
    expect(objects.has(`${MATCHES}latest.meta.json`)).toBe(true);
  });

  it('aborts without touching latest when too many rows are malformed', async () => {
    putSessions('live/good', Array.from({ length: 10 }, (_, i) => row({ session_id: `s${i}` })));
    putSessions('live/bad', [{ nonsense: true }, { also: 'nonsense' }]);

    await expect(runCollabExport(BUCKET, 'exp-7', '2026-08-02T00:00:00.000Z')).rejects.toThrow(/skip fraction/);
    expect(objects.has(`${MATCHES}latest.meta.json`)).toBe(false);
  });

  it('counts a row that parses but carries no ids into the SAME tolerance', async () => {
    putSessions('live/good', Array.from({ length: 200 }, (_, i) => row({ session_id: `s${i}` })));
    putSessions('live/idless', [row({ session_id: 'x', agent_id: '' })]);

    const meta = await runCollabExport(BUCKET, 'exp-8', '2026-08-02T00:00:00.000Z');

    expect(meta.row_count).toBe(200);
  });
});

describe('listUngradedSessions', () => {
  it('offers a gated session for grading rather than dropping it silently', async () => {
    putSessions('live/s1/2026-08-01T00-00-01-000Z', [
      row({ session_id: 's1', outcome: 'gated', terminal_state: 'gated' }),
    ]);

    const pending = await listUngradedSessions(BUCKET, 10);

    expect(pending.map((p) => p.sessionId)).toEqual(['s1']);
    expect(pending[0].tenantId).toBe('t1');
  });

  it('skips a session that already has a grade object', async () => {
    putSessions('live/s1', [row({ session_id: 's1' })]);
    putSessions('live/s2', [row({ session_id: 's2', emitted_at: '2026-08-01T00:00:05.000Z' })]);
    objects.set('diagnostics/grades/s1.ndjson', JSON.stringify({ session_id: 's1', score: 80 }) + '\n');

    const pending = await listUngradedSessions(BUCKET, 10);

    expect(pending.map((p) => p.sessionId)).toEqual(['s2']);
  });
});
