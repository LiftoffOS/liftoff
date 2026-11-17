/**
 * browser-sessions/repository — verifies query shape + row→domain mapping
 * for every function on the repo. Pool is mocked; tests assert the SQL/params
 * and the mapped return value, not real database behaviour.
 */
const poolQueryMock = jest.fn();
// The session-state writers run in ONE tenant-scoped transaction. The fake
// scope records which tenant it opened for, hands every statement to one
// client, and — like the real one — commits only when the callback returns:
// a throw is a rollback, and nothing written before it survives.
const scopedQueryMock = jest.fn();
const scopes: Array<{ tenantId: string; statements: string[]; committed: boolean }> = [];
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => poolQueryMock(...args) }),
  withTenantScope: async (tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const scope = { tenantId, statements: [] as string[], committed: false };
    scopes.push(scope);
    const client = {
      query: (...args: unknown[]) => {
        scope.statements.push(String(args[0]).replace(/\s+/g, ' ').trim());
        return scopedQueryMock(...args);
      },
    };
    const result = await fn(client);
    scope.committed = true;
    return result;
  },
}));

import * as repo from '../repository';

const rawRow = {
  id: 'sid',
  tenant_id: 'tid',
  agent_id: 'aid',
  thread_id: 'thid',
  vendor: 'anchor',
  vendor_session_id: 'vsid',
  vendor_metadata: { live_view_url: 'https://live.anchor/abc' },
  created_at: new Date('2026-06-10T00:00:00Z'),
  last_used_at: new Date('2026-06-10T00:01:00Z'),
  expires_at: new Date('2026-06-10T01:00:00Z'),
  closed_at: null,
  takeover_state: 'none',
  taken_over_at: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  scopes.length = 0;
});

describe('repository row mapping', () => {
  it('maps a closed session and reads liveViewUrl from vendor_metadata', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    const session = await repo.getById('sid');
    expect(session).not.toBeNull();
    expect(session!.id).toBe('sid');
    expect(session!.tenantId).toBe('tid');
    expect(session!.threadId).toBe('thid');
    expect(session!.vendor).toBe('anchor');
    expect(session!.vendorSessionId).toBe('vsid');
    expect(session!.liveViewUrl).toBe('https://live.anchor/abc');
    expect(session!.takeoverState).toBe('none');
  });

  it('falls back to liveViewUrl=null when vendor_metadata missing the field', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ ...rawRow, vendor_metadata: {} }],
    });
    const session = await repo.getById('sid');
    expect(session!.liveViewUrl).toBeNull();
  });

  it('returns null when no row found', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await repo.getById('missing')).toBeNull();
  });
});

describe('listForThread', () => {
  it('excludes closed sessions when includeClosed=false', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow, rawRow] });
    await repo.listForThread('tid', 'thid', { includeClosed: false });
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).toContain('closed_at IS NULL');
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['tid', 'thid']);
  });

  it('includes closed sessions when includeClosed=true', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await repo.listForThread('tid', 'thid', { includeClosed: true });
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).not.toContain('closed_at IS NULL');
  });

  it('orders by created_at DESC', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await repo.listForThread('tid', 'thid', { includeClosed: false });
    expect(poolQueryMock.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
  });
});

describe('getActiveForThread', () => {
  it('filters to open sessions only', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForThread('tid', 'thid');
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).toContain('closed_at IS NULL');
    expect(sql).toContain('LIMIT 1');
  });

  // A row stays open until the reaper closes it, minutes after the vendor
  // released the browser at expires_at. In between it is not this thread's
  // session: handing it back wedges the pane, because the caller only opens
  // a new one when this answers nothing.
  it('does not answer with a session the vendor has already released', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await repo.getActiveForThread('tid', 'thid');
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('expires_at > now()');
    expect(params).toEqual(['tid', 'thid', false, false]);
  });

  it('answers with an expired session for the paths that close one', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForThread('tid', 'thid', { includeExpired: true });
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['tid', 'thid', true, false]);
  });

  // Collecting a task that carried on reads a RECORD, not a browser, and
  // the moment it is most likely to be collected is after the session has
  // ended. It used to be refused with "no active browser session", with the
  // answer sitting on the row the lookup skipped.
  it('answers with a CLOSED session for the paths that read what one recorded', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForThread('tid', 'thid', { includeClosed: true });
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['tid', 'thid', true, true]);
  });

  // Asking past closed_at and stopping at expires_at would answer nothing
  // for every session that outlived its lease, which is all of them by the
  // time they close.
  it('reading a closed session implies reading an expired one', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForThread('tid', 'thid', { includeClosed: true, includeExpired: false });
    expect(poolQueryMock.mock.calls[0][1][2]).toBe(true);
  });
});

describe('getActiveForInvocation', () => {
  it('holds the same expiry rule, and yields to the close path', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await repo.getActiveForInvocation('tid', 'inv');
    expect(poolQueryMock.mock.calls[0][0]).toContain('expires_at > now()');
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['tid', 'inv', false, false]);
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForInvocation('tid', 'inv', { includeExpired: true });
    expect(poolQueryMock.mock.calls[1][1]).toEqual(['tid', 'inv', true, false]);
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForInvocation('tid', 'inv', { includeClosed: true });
    expect(poolQueryMock.mock.calls[2][1]).toEqual(['tid', 'inv', true, true]);
  });
});

// ── The session-state writers: paired writes, one client, one transaction ──
//
// A takeover hold must open and close exactly when the session's state does.
// Each writer reads the session's tenant first (the holds table is FORCE RLS)
// and then issues the web_sessions update AND the hold write on the same
// client inside one scope, so a rollback after the session update leaves
// neither an open hold without a takeover nor a takeover without a hold.

const holdRow = {
  id: 'hold-1', tenant_id: 'tid', session_id: 'sid', thread_id: 'thid',
  started_at: new Date('2026-09-17T00:00:00Z'), ended_at: null, end_reason: null,
  capture_owner: null, capture_generation: 0, capture_lease_until: null,
  capture_gap: false, gap_reason: null,
};

describe('startTakeover', () => {
  it('moves an open session from none to taken_over and inserts the hold in one tenant-scoped transaction', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over', taken_over_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [holdRow] })
      .mockResolvedValueOnce({ rows: [] }); // no pending request for the person

    const result = await repo.startTakeover('sid');

    expect(poolQueryMock.mock.calls[0][0]).toContain('SELECT tenant_id FROM web_sessions');
    expect(scopes).toHaveLength(1);
    expect(scopes[0].tenantId).toBe('tid');
    expect(scopes[0].committed).toBe(true);
    const [transition, insert, answer] = scopes[0].statements;
    expect(transition).toContain("SET takeover_state = 'taken_over', taken_over_at = NOW()");
    expect(transition).toContain("closed_at IS NULL AND takeover_state = 'none'");
    expect(insert).toContain('INSERT INTO browser_takeover_holds (tenant_id, session_id, thread_id)');
    expect(insert).toContain('ON CONFLICT (session_id) WHERE ended_at IS NULL DO NOTHING');
    expect(scopedQueryMock.mock.calls[1][1]).toEqual(['tid', 'sid', 'thid']);
    // The pending request for the person, answered by this hold on the
    // transaction's own client (migration 431).
    expect(answer).toContain("UPDATE browser_interventions SET status = 'answered', hold_id = $2");
    expect(answer).toContain("WHERE session_id = $1 AND status = 'pending'");
    expect(scopedQueryMock.mock.calls[2][1]).toEqual(['sid', 'hold-1']);
    expect(result).toMatchObject({ renewed: false, hold: { id: 'hold-1', captureGeneration: 0, kind: 'takeover' } });
    expect(result!.session.takeoverState).toBe('taken_over');
  });

  it('answers a pending request for the person with the hold that answered it, on the same client', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over', taken_over_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [holdRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-1', tenant_id: 'tid', session_id: 'sid', status: 'answered', hold_id: 'hold-1', reason: 'sign in', requested_at: new Date() }] });
    const result = await repo.startTakeover('sid');
    expect(result!.hold.id).toBe('hold-1');
    expect(scopes[0].statements).toHaveLength(3);
    expect(scopes[0].committed).toBe(true);
  });

  it('renews an already taken-over session and returns the SAME open hold', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [] })                                        // not in 'none'
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over' }] }) // restamp
      .mockResolvedValueOnce({ rows: [holdRow] });                                // the open hold

    const result = await repo.startTakeover('sid');

    const [, restamp, lookup] = scopes[0].statements;
    expect(restamp).toContain('SET taken_over_at = NOW()');
    expect(restamp).toContain("takeover_state = 'taken_over'");
    expect(lookup).toContain('FROM browser_takeover_holds WHERE session_id = $1 AND ended_at IS NULL');
    expect(result).toMatchObject({ renewed: true, hold: { id: 'hold-1' } });
    expect(scopes[0].statements).toHaveLength(3);
  });

  it('creates a never_attached hold on a renewal that finds none (an older hold from before the table)', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...holdRow, capture_gap: true, gap_reason: 'never_attached' }] });

    const result = await repo.startTakeover('sid');

    const insert = scopes[0].statements[3];
    expect(insert).toContain("VALUES ($1, $2, $3, true, 'never_attached')");
    expect(result).toMatchObject({ renewed: true, hold: { captureGap: true, gapReason: 'never_attached' } });
  });

  it('re-reads the open hold when a competing start already inserted one', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over' }] })
      .mockResolvedValueOnce({ rows: [] })        // ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [holdRow] }) // the winner's hold
      .mockResolvedValueOnce({ rows: [] });       // no pending request

    const result = await repo.startTakeover('sid');
    expect(result!.hold.id).toBe('hold-1');
    expect(result!.renewed).toBe(false);
  });

  it('returns null and writes nothing for a closed or missing session', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await repo.startTakeover('gone')).toBeNull();
    expect(scopes).toHaveLength(0);

    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await repo.startTakeover('sid')).toBeNull();
  });

  it('leaves no takeover without a hold: a failed hold insert rolls the transition back', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [{ ...rawRow, takeover_state: 'taken_over' }] })
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(repo.startTakeover('sid')).rejects.toThrow('connection lost');
    // The transition was issued on the scope that never committed, so the
    // real withTenantScope rolls it back with the failed insert.
    expect(scopes[0].committed).toBe(false);
    expect(scopes[0].statements[0]).toContain("SET takeover_state = 'taken_over'");
  });
});

describe('endTakeover', () => {
  it('clears the takeover, ends the open hold with the reason and answers its id, and cancels an unanswered request, on one client', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [rawRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'hold-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const result = await repo.endTakeover('sid', 'absent_driver');

    expect(scopes[0].tenantId).toBe('tid');
    expect(scopes[0].committed).toBe(true);
    const [clear, end, cancel] = scopes[0].statements;
    expect(clear).toContain("SET takeover_state = 'none', taken_over_at = NULL");
    expect(end).toContain('UPDATE browser_takeover_holds SET ended_at = now(), end_reason = $2');
    expect(end).toContain('WHERE session_id = $1 AND ended_at IS NULL');
    expect(end).toContain('RETURNING id');
    expect(scopedQueryMock.mock.calls[1][1]).toEqual(['sid', 'absent_driver']);
    expect(cancel).toContain("UPDATE browser_interventions SET status = $2, ended_at = now() WHERE session_id = $1 AND status = 'pending'");
    expect(scopedQueryMock.mock.calls[2][1]).toEqual(['sid', 'cancelled']);
    expect(result!.session.takeoverState).toBe('none');
    // The hold this release ended, for the control plane's hand-back.
    expect(result!.holdId).toBe('hold-1');
  });

  it('answers a null hold id when no hold was open', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [rawRow] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const result = await repo.endTakeover('sid', 'released');
    expect(result!.holdId).toBeNull();
  });

  it('leaves no open hold without a takeover: a failed hold end rolls the clear back', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [rawRow] })
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(repo.endTakeover('sid', 'released')).rejects.toThrow('connection lost');
    expect(scopes[0].committed).toBe(false);
  });
});

describe('endTakeoverHoldForClose', () => {
  it('ends the open hold as session_closed, under the tenant, and touches no session column', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await repo.endTakeoverHoldForClose('sid')).toBe(true);
    expect(scopes[0].tenantId).toBe('tid');
    expect(scopes[0].statements).toHaveLength(1);
    expect(scopes[0].statements[0]).toContain("UPDATE browser_takeover_holds SET ended_at = now(), end_reason = 'session_closed'");
    expect(scopes[0].statements[0]).toContain('WHERE session_id = $1 AND ended_at IS NULL');
    expect(scopes[0].statements[0]).not.toContain('web_sessions');
  });

  it('is a no-op on a session with no open hold, and on a missing session', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock.mockResolvedValueOnce({ rowCount: 0 });
    expect(await repo.endTakeoverHoldForClose('sid')).toBe(false);
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await repo.endTakeoverHoldForClose('gone')).toBe(false);
    expect(scopes).toHaveLength(1);
  });
});

describe('closeSession', () => {
  it('closes only a still-open row, with the reason, and ends the hold as session_closed together', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock
      .mockResolvedValueOnce({ rows: [{ ...rawRow, closed_at: new Date(), closed_reason: 'idle_timeout' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const result = await repo.closeSession('sid', 'idle_timeout');

    const [close, end, cancel] = scopes[0].statements;
    expect(close).toContain('SET closed_at = NOW(), closed_reason = $2');
    expect(close).toContain('WHERE id = $1 AND closed_at IS NULL');
    expect(scopedQueryMock.mock.calls[0][1]).toEqual(['sid', 'idle_timeout']);
    expect(scopedQueryMock.mock.calls[1][1]).toEqual(['sid', 'session_closed']);
    expect(end).toContain('UPDATE browser_takeover_holds SET ended_at = now()');
    // A request for the person to take over dies with the session.
    expect(cancel).toContain("UPDATE browser_interventions SET status = $2, ended_at = now()");
    expect(scopedQueryMock.mock.calls[2][1]).toEqual(['sid', 'cancelled']);
    expect(result!.closedReason).toBe('idle_timeout');
  });

  it('writes nothing more when the session was already closed', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ tenant_id: 'tid' }] });
    scopedQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await repo.closeSession('sid', 'failed')).toBeNull();
    expect(scopes[0].statements).toHaveLength(1);
  });
});

describe('setCurrentUrl', () => {
  it('merges current_url, WHEN it was read and the title into vendor_metadata for the live row + bumps last_used_at', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ ...rawRow, vendor_metadata: { ...rawRow.vendor_metadata, current_url: 'https://x.com', current_url_at: '2026-09-21T21:02:40.000Z', current_title: 'X' } }],
    });
    const session = await repo.setCurrentUrl('vsid', 'https://x.com', 'X');
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).toContain('current_url');
    // Stamped with its own time: `last_used_at` is restamped by every touch
    // and cannot order the page line against the newest hold action.
    expect(sql).toContain("'current_url_at', now()::text");
    expect(sql).toContain('current_title');
    expect(sql).toContain('closed_at IS NULL');
    expect(sql).toContain('last_used_at = now()');
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['vsid', 'https://x.com', 'X']);
    expect(session!.currentUrl).toBe('https://x.com');
    expect(session!.currentUrlAt).toEqual(new Date('2026-09-21T21:02:40.000Z'));
    expect(session!.currentTitle).toBe('X');
  });

  it('leaves the title alone when the caller had none', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.setCurrentUrl('vsid', 'https://x.com');
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['vsid', 'https://x.com', null]);
  });
});

describe('setViewport and setPageSnapshot', () => {
  it('stores the pane viewport on the live row and maps it back', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ ...rawRow, vendor_metadata: { viewport: { width: 900, height: 640 } } }] });
    const session = await repo.setViewport('sid', { width: 900, height: 640 });
    expect(poolQueryMock.mock.calls[0][0]).toContain("'viewport'");
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['sid', 900, 640]);
    expect(session!.viewport).toEqual({ width: 900, height: 640 });
  });

  it('stores the page snapshot and reads only a well-formed one back', async () => {
    const snapshot = { id: 'snap', url: 'https://x.com/', takenAt: '2026-09-21T21:02:40.000Z', controls: [{ ref: 'c0', role: 'link', name: 'Sports', nth: 0, frameId: null }] };
    poolQueryMock.mockResolvedValueOnce({ rows: [{ ...rawRow, vendor_metadata: { page_snapshot: snapshot } }] });
    const session = await repo.setPageSnapshot('sid', snapshot);
    expect(poolQueryMock.mock.calls[0][0]).toContain("'page_snapshot'");
    expect(session!.pageSnapshot).toEqual(snapshot);
    poolQueryMock.mockResolvedValueOnce({ rows: [{ ...rawRow, vendor_metadata: { page_snapshot: { id: 'x' } } }] });
    expect((await repo.getById('sid'))!.pageSnapshot).toBeNull();
  });
});

describe('new field mapping', () => {
  it('maps owner_account_id, caller_session_id, and current_url', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{
        ...rawRow,
        owner_account_id: 'acc-1',
        caller_session_id: 'ui:abc',
        vendor_metadata: { ...rawRow.vendor_metadata, current_url: 'https://x.com' },
      }],
    });
    const session = await repo.getById('sid');
    expect(session!.ownerAccountId).toBe('acc-1');
    expect(session!.callerSessionId).toBe('ui:abc');
    expect(session!.currentUrl).toBe('https://x.com');
  });

  it('defaults the new fields to null when absent', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    const session = await repo.getById('sid');
    expect(session!.ownerAccountId).toBeNull();
    expect(session!.callerSessionId).toBeNull();
    expect(session!.currentUrl).toBeNull();
  });
});

describe('recordWebhookEvent', () => {
  it('returns inserted=true on a fresh envelope id', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 1 });
    const result = await repo.recordWebhookEvent('evt-1', 'session.completed', 'vsid', { x: 1 });
    expect(result.inserted).toBe(true);
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('returns inserted=false when envelope id already exists', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0 });
    const result = await repo.recordWebhookEvent('evt-1', 'session.completed', 'vsid', {});
    expect(result.inserted).toBe(false);
  });
});

describe('getActiveForCallerSession', () => {
  it('scopes by tenant + agent + caller_session_id and excludes closed', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [rawRow] });
    await repo.getActiveForCallerSession('tid', 'aid', 'caller-1');
    const sql = poolQueryMock.mock.calls[0][0];
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('agent_id = $2');
    expect(sql).toContain('caller_session_id = $3');
    expect(sql).toContain('closed_at IS NULL');
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['tid', 'aid', 'caller-1']);
  });
});
