// The capture lease: who records a hold, and what a stale owner can do.
//
// One owner per hold at a time, by a lease on the row. The properties held
// here, over an ordered pool mock for the statements and fakes for the
// browser: a fresh hold claims at generation 1 with no gap; a second claim
// while the lease is live gets nothing; a claim after expiry moves to
// generation 2 and records lost_owner; a renewal from the old generation
// returns nothing; an insert from it writes nothing; a release nulls the
// owner and records the gap; and a renewal is never issued while no page has
// the recorder installed.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The orchestrator is driven here too, over the real repository; the vendor
// clients are never loaded.
jest.mock('../../session-vendor-proxy', () => ({ cdpEndpointFor: jest.fn() }));

const scopedQuery = jest.fn();
const scopeTenants: string[] = [];
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: async (tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    scopeTenants.push(tenantId);
    return fn({ query: (...args: unknown[]) => scopedQuery(...args) });
  },
}));

import * as repo from '../repository';
import { ensureTakeoverCapture, _detachAllTakeoverCaptures, CAPTURE_OWNER } from '../index';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const HOLD = '11111111-1111-4111-8111-111111111111';
const OWNER = 'host:1:owner-a';

function sqlOf(call: number): string {
  return String(scopedQuery.mock.calls[call][0]).replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  jest.clearAllMocks();
  scopeTenants.length = 0;
});

describe('claim', () => {
  it('claims a fresh hold at generation 1, under the tenant, reading the previous generation under lock in the same statement', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [{ capture_generation: 1 }] });
    const generation = await repo.claimCapture(TENANT, HOLD, OWNER);
    expect(generation).toBe(1);
    expect(scopeTenants).toEqual([TENANT]);
    const sql = sqlOf(0);
    expect(sql).toContain('WITH prev AS ( SELECT id, capture_generation FROM browser_takeover_holds');
    expect(sql).toContain('(capture_owner IS NULL OR capture_lease_until < now()) FOR UPDATE )');
    expect(sql).toContain('capture_generation = prev.capture_generation + 1');
    expect(sql).toContain("capture_lease_until = now() + interval '60 seconds'");
    // The gap and its reason come from the PREVIOUS generation, in the same
    // statement: a first claim (0 -> 1) records nothing, a later one does.
    expect(sql).toContain('capture_gap = h.capture_gap OR prev.capture_generation > 0');
    expect(sql).toContain("COALESCE(h.gap_reason, CASE WHEN prev.capture_generation > 0 THEN 'lost_owner' END)");
    expect(sql).toContain('RETURNING h.capture_generation');
    expect(scopedQuery.mock.calls[0][1]).toEqual([HOLD, OWNER]);
  });

  it('gets nothing while another owner holds a live lease, and does not treat that as a gap', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.claimCapture(TENANT, HOLD, 'host:2:owner-b')).toBeNull();
    expect(scopedQuery).toHaveBeenCalledTimes(1);
  });

  it('moves to generation 2 after the previous lease expired', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [{ capture_generation: 2 }] });
    expect(await repo.claimCapture(TENANT, HOLD, 'host:2:owner-b')).toBe(2);
  });
});

describe('renew', () => {
  it('extends only the owner\'s own generation on an open hold', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [{ id: HOLD }] });
    expect(await repo.renewCapture(TENANT, HOLD, OWNER, 1)).toBe(true);
    const sql = sqlOf(0);
    expect(sql).toContain("SET capture_lease_until = now() + interval '60 seconds'");
    expect(sql).toContain('WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL RETURNING id');
    expect(scopedQuery.mock.calls[0][1]).toEqual([HOLD, OWNER, 1]);
  });

  it('returns nothing from a generation that has been taken over', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.renewCapture(TENANT, HOLD, OWNER, 1)).toBe(false);
  });
});

describe('insert through the hold', () => {
  const action = {
    nonce: 'n', seq: 0, kind: 'click' as const, url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
    tag: 'button', role: 'button', name: 'Go', nameTruncated: false, nameProtectedDataOmitted: false, inputType: null,
    value: null, valueTruncated: false, valueDisposition: 'none' as const, detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
  };

  it('writes nothing from a stale generation: the lock finds no row', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.insertAction(TENANT, HOLD, OWNER, 1, action)).toBe('stale');
    expect(scopedQuery).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toContain('WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL FOR UPDATE');
  });

  it('locks, counts, then inserts through the hold under the cap, in one scope', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rows: [{ id: HOLD }] })
      .mockResolvedValueOnce({ rows: [{ n: '3' }] })
      .mockResolvedValueOnce({ rows: [{ seq: 0 }] });
    expect(await repo.insertAction(TENANT, HOLD, OWNER, 2, action)).toBe('inserted');
    expect(scopeTenants).toEqual([TENANT]);
    expect(sqlOf(1)).toContain('SELECT COUNT(*) AS n FROM browser_takeover_actions WHERE hold_id = $1');
    const insert = sqlOf(2);
    expect(insert).toContain('INSERT INTO browser_takeover_actions');
    expect(insert).toContain('FROM browser_takeover_holds h WHERE h.id = $1 AND h.capture_owner = $12 AND h.capture_generation = $3 AND h.ended_at IS NULL');
    expect(insert).toContain('ON CONFLICT DO NOTHING');
    expect(scopedQuery.mock.calls[2][1]).toEqual([
      HOLD, TENANT, 2, 'n', 0, 'click', 'https://a.example/', 'button', 'button', 'Go', null, OWNER,
      null, 'none', null, false, false, false, false, false, false, false,
    ]);
    expect(insert).toContain('value, value_disposition, detail');
  });

  it('refuses the 501st and records the cap gap on the first refusal', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rows: [{ id: HOLD }] })
      .mockResolvedValueOnce({ rows: [{ n: '500' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect(await repo.insertAction(TENANT, HOLD, OWNER, 1, action)).toBe('capped');
    expect(sqlOf(2)).toContain("SET capture_gap = true, gap_reason = COALESCE(gap_reason, 'cap')");
  });

  it('reports a duplicate delivery without writing twice', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rows: [{ id: HOLD }] })
      .mockResolvedValueOnce({ rows: [{ n: '1' }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await repo.insertAction(TENANT, HOLD, OWNER, 1, action)).toBe('duplicate');
  });
});

describe('release', () => {
  it('nulls the owner and lease, sets the gap, keeps an earlier reason, only for its own generation on an OPEN hold', async () => {
    scopedQuery.mockResolvedValueOnce({ rowCount: 1 });
    await repo.releaseCapture(TENANT, HOLD, OWNER, 1, 'lost_owner');
    const sql = sqlOf(0);
    expect(sql).toContain('SET capture_owner = NULL, capture_lease_until = NULL, capture_gap = true, gap_reason = COALESCE(gap_reason, $4)');
    // A hold that has ended has nothing left to observe: a disconnect after
    // its end (the browser being stopped by the close that ended it) writes
    // no gap.
    expect(sql).toContain('WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL');
    expect(scopedQuery.mock.calls[0][1]).toEqual([HOLD, OWNER, 1, 'lost_owner']);
  });

  it('marks a gap on a hold nobody claimed (capture disabled)', async () => {
    scopedQuery.mockResolvedValueOnce({ rowCount: 1 });
    await repo.markCaptureGap(TENANT, HOLD, 'disabled');
    expect(sqlOf(0)).toContain('SET capture_gap = true, gap_reason = COALESCE(gap_reason, $2) WHERE id = $1');
    expect(scopedQuery.mock.calls[0][1]).toEqual([HOLD, 'disabled']);
  });
});

describe('the read behind ListTakeoverActivity', () => {
  it('pages on (started_at, id) newest first, one past the limit, with actions oldest first per hold', async () => {
    const started = new Date('2026-09-17T10:00:00Z');
    scopedQuery
      .mockResolvedValueOnce({ rows: [
        { id: HOLD, started_at: started, ended_at: null, end_reason: null, capture_gap: false, gap_reason: null, session_closed_at: null, session_takeover_state: 'taken_over' },
        { id: '22222222-2222-4222-8222-222222222222', started_at: started, ended_at: started, end_reason: 'released', capture_gap: true, gap_reason: 'cap', session_closed_at: null, session_takeover_state: 'none' },
        { id: '33333333-3333-4333-8333-333333333333', started_at: started, ended_at: started, end_reason: 'released', capture_gap: false, gap_reason: null, session_closed_at: null, session_takeover_state: 'none' },
      ] })
      .mockResolvedValueOnce({ rows: [
        {
          hold_id: HOLD, kind: 'click', url: 'https://a.example/', tag: 'button', role: 'button', name: 'Go', input_type: null,
          at: new Date('2026-09-17T10:01:00Z'), value: null, value_disposition: 'none', detail: null,
          url_truncated: false, name_truncated: false, value_truncated: false, detail_truncated: false,
          url_protected_data_omitted: false, name_protected_data_omitted: false, detail_protected_data_omitted: false,
        },
      ] });
    const result = await repo.listTakeoverHolds(TENANT, 'thread-1', { limit: 2, before: { startedAt: started, id: HOLD } });
    const sql = sqlOf(0);
    expect(sql).toContain('JOIN web_sessions s ON s.id = h.session_id');
    expect(sql).toContain('($3::timestamptz IS NULL OR (h.started_at, h.id) < ($3::timestamptz, $4::uuid))');
    expect(sql).toContain('ORDER BY h.started_at DESC, h.id DESC LIMIT $5');
    // The optional hold filter (432): null lists the thread's holds as before.
    expect(sql).toContain('($6::uuid IS NULL OR h.id = $6::uuid)');
    expect(scopedQuery.mock.calls[0][1]).toEqual([TENANT, 'thread-1', started, HOLD, 3, null]);
    expect(sqlOf(1)).toContain('ORDER BY at ASC, page_nonce ASC, seq ASC');
    expect(result.hasMore).toBe(true);
    expect(result.holds).toHaveLength(2);
    expect(result.holds[0]).toMatchObject({ id: HOLD, kind: 'takeover', sessionTakeoverState: 'taken_over', captureGap: false, gapReason: null, actionsOmitted: 0 });
    expect(result.holds[0].actions).toEqual([
      {
        kind: 'click', url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
        tag: 'button', role: 'button', name: 'Go', nameTruncated: false, nameProtectedDataOmitted: false, inputType: null,
        value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
        at: new Date('2026-09-17T10:01:00Z'),
      },
    ]);
    expect(result.holds[1].actions).toEqual([]);
    // Every new column is read by name.
    expect(sqlOf(1)).toContain('value, value_disposition, detail');
    expect(sqlOf(1)).toContain('url_protected_data_omitted, name_protected_data_omitted, detail_protected_data_omitted');
  });

  it('names exactly one hold when asked, and takes the newest N actions of each hold with the older ones counted', async () => {
    const started = new Date('2026-09-17T10:00:00Z');
    scopedQuery
      .mockResolvedValueOnce({ rows: [
        { id: HOLD, kind: 'point', started_at: started, ended_at: started, end_reason: 'released', capture_gap: false, gap_reason: null, session_closed_at: null, session_takeover_state: 'none' },
      ] })
      .mockResolvedValueOnce({ rows: [
        {
          hold_id: HOLD, kind: 'click', url: 'https://a.example/', tag: 'a', role: 'link', name: 'Old', input_type: null,
          at: new Date('2026-09-17T10:01:00Z'), value: null, value_disposition: 'none', detail: null,
          url_truncated: false, name_truncated: false, value_truncated: false, detail_truncated: false,
          url_protected_data_omitted: false, name_protected_data_omitted: false, detail_protected_data_omitted: false,
          rn: 2, total: '25',
        },
        {
          hold_id: HOLD, kind: 'click', url: 'https://a.example/', tag: 'a', role: 'link', name: 'New', input_type: null,
          at: new Date('2026-09-17T10:02:00Z'), value: null, value_disposition: 'none', detail: null,
          url_truncated: false, name_truncated: false, value_truncated: false, detail_truncated: false,
          url_protected_data_omitted: false, name_protected_data_omitted: false, detail_protected_data_omitted: false,
          rn: 1, total: '25',
        },
      ] });
    const result = await repo.listTakeoverHolds(TENANT, 'thread-1', { limit: 1, holdId: HOLD, newestActions: 20 });
    expect(scopedQuery.mock.calls[0][1]).toEqual([TENANT, 'thread-1', null, null, 2, HOLD]);
    // The newest N are picked in the database, in the same order the full
    // read uses, and the count of the older ones rides beside them.
    expect(sqlOf(1)).toContain('row_number() OVER (PARTITION BY hold_id ORDER BY at DESC, page_nonce DESC, seq DESC) AS rn');
    expect(sqlOf(1)).toContain('WHERE rn <= $2');
    expect(scopedQuery.mock.calls[1][1]).toEqual([[HOLD], 20]);
    expect(result.holds[0]).toMatchObject({ id: HOLD, kind: 'point', actionsOmitted: 5 });
    expect(result.holds[0].actions.map((a) => a.name)).toEqual(['Old', 'New']);
  });

  it('refuses an unknown stored disposition rather than coercing it', async () => {
    const started = new Date('2026-09-17T10:00:00Z');
    scopedQuery
      .mockResolvedValueOnce({ rows: [
        { id: HOLD, started_at: started, ended_at: null, end_reason: null, capture_gap: false, gap_reason: null, session_closed_at: null, session_takeover_state: 'taken_over' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { hold_id: HOLD, kind: 'change', url: 'https://a.example/', tag: 'input', role: 'textbox', name: 'Q', input_type: 'text', at: started, value: 'x', value_disposition: 'mystery' },
      ] });
    await expect(repo.listTakeoverHolds(TENANT, 'thread-1', { limit: 2 })).rejects.toThrow(/unknown value: mystery/);
  });

  it('lists the holds that overlap an interval on a session, open holds included', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [{ started_at: new Date('2026-09-17T10:00:00Z'), ended_at: null }] });
    const from = new Date('2026-09-17T10:01:00Z');
    const to = new Date('2026-09-17T10:02:00Z');
    const holds = await repo.listHoldsOverlapping(TENANT, 'sid', from, to);
    expect(sqlOf(0)).toContain('AND (ended_at IS NULL OR ended_at >= $2)');
    expect(scopedQuery.mock.calls[0][1]).toEqual(['sid', from, to]);
    expect(holds).toEqual([{ startedAt: new Date('2026-09-17T10:00:00Z'), endedAt: null }]);
  });
});

/** The lease is only held while observing, driven through the orchestrator
 *  over this same repository: no renewal statement is issued while no page
 *  session has the recorder installed. */
describe('renewal is not issued while no page session is attached', () => {
  const hold = {
    id: HOLD, tenantId: TENANT, sessionId: 'sid', threadId: 'th',
    startedAt: new Date(), endedAt: null, endReason: null,
    captureOwner: null, captureGeneration: 0, captureLeaseUntil: null, captureGap: false, gapReason: null,
  };
  const session = {
    id: 'sid', tenantId: TENANT, agentId: 'a', threadId: 'th', invocationId: null,
    vendor: 'steel', vendorSessionId: 'vsid', liveViewUrl: null, createdAt: new Date(),
    lastUsedAt: null, expiresAt: null, closedAt: null, closedReason: null,
    takeoverState: 'taken_over' as const, takenOverAt: new Date(), ownerAccountId: null,
    callerSessionId: null, currentUrl: null, lastScreenshotObjectPath: null, lastScreenshotAt: null,
  };
  const renewals = () => scopedQuery.mock.calls
    .map((c) => String(c[0]).replace(/\s+/g, ' '))
    .filter((sql) => sql.includes("SET capture_lease_until = now() + interval '60 seconds' WHERE id = $1 AND capture_owner = $2"));

  beforeEach(() => { jest.useFakeTimers(); delete process.env.TR_TAKEOVER_CAPTURE_ENABLED; });
  afterEach(async () => { await _detachAllTakeoverCaptures(); jest.useRealTimers(); });

  it('a browser with no page installs no recorder, releases never_attached, and renews nothing afterwards', async () => {
    scopedQuery.mockImplementation(async (sql: string) => {
      const text = String(sql).replace(/\s+/g, ' ');
      if (text.includes('WITH prev AS')) return { rows: [{ capture_generation: 1 }] };   // claim
      if (text.includes('RETURNING id')) return { rows: [{ id: HOLD }] };                // renew (the re-check)
      return { rows: [], rowCount: 1 };
    });
    const browser = {
      contexts: () => [{ pages: () => [], on: () => undefined, newCDPSession: async () => { throw new Error('no page'); } }],
      on: () => undefined,
      close: jest.fn(async () => undefined),
    };
    await ensureTakeoverCapture(
      { tenantId: TENANT, hold, session },
      { deps: { connect: async () => browser as never, endpointFor: async () => 'ws://x', renewIntervalMs: 20_000 } },
    );
    const released = scopedQuery.mock.calls.find((c) => String(c[0]).includes('SET capture_owner = NULL'));
    expect(released?.[1]).toEqual([HOLD, CAPTURE_OWNER, 1, 'never_attached']);
    // One renewal statement: the re-check at connect. None on the interval.
    expect(renewals()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(renewals()).toHaveLength(1);
    expect(browser.close).toHaveBeenCalled();
  });
});
