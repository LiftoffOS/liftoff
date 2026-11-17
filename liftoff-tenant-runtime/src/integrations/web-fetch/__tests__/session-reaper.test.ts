/**
 * The reaper, and the one property that makes browser spend auditable:
 * `closed_reason` must say whether the session's cost was SETTLED.
 *
 * It could not before. Every close path wrote NULL, so a healthy close by
 * `web_session_close` and a row taken by the janitor without stopping the
 * vendor were indistinguishable in the table, so sessions could sit unbilled
 * without anyone noticing.
 *
 * Settling happens in exactly one place — the vendor's closeSession — so the
 * rule is simply: reached it and returned → a reason that means settled;
 * did not → 'failed'.
 */

const closeVendorSessionMock = jest.fn();
jest.mock('../../../browser-sessions/session-vendor-proxy', () => ({
  closeSession: (...a: unknown[]) => closeVendorSessionMock(...a),
}));

// The local close goes through the repository's closeSession — the ONE writer
// of closed_at, which ends an open takeover hold in the same transaction — so
// what the reaper decides is the reason it hands over.
const closeSessionRowMock = jest.fn();
const endTakeoverHoldForCloseMock = jest.fn();
jest.mock('../../../browser-sessions/repository', () => ({
  closeSession: (...a: unknown[]) => closeSessionRowMock(...a),
  endTakeoverHoldForClose: (...a: unknown[]) => endTakeoverHoldForCloseMock(...a),
}));

const queryMock = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { SessionReaper } from '../session-reaper';

const expiredRow = {
  id: 'row-1',
  tenant_id: 'tenant-1',
  vendor: 'browser_use',
  vendor_session_id: 'vsid-1',
};

/** The reaper's one query selects expired rows; the closes go to the repository. */
function withExpiredRows(rows: unknown[]) {
  queryMock.mockReset();
  queryMock.mockImplementation(() => ({ rows, rowCount: rows.length }));
  closeSessionRowMock.mockReset();
  closeSessionRowMock.mockResolvedValue({ id: 'row-1', closedAt: new Date() });
  endTakeoverHoldForCloseMock.mockReset();
  endTakeoverHoldForCloseMock.mockResolvedValue(false);
}

/** The reasons the reaper closed rows with, in order. */
function closeReasons(): string[] {
  return closeSessionRowMock.mock.calls.map((c) => String(c[1]));
}

const reaper = () => new SessionReaper({} as never, {} as never, {} as never);

beforeEach(() => {
  jest.clearAllMocks();
  closeVendorSessionMock.mockReset();
});

describe('a session the reaper settles', () => {
  it('stops it at the vendor, which is what records the cost', async () => {
    withExpiredRows([expiredRow]);
    closeVendorSessionMock.mockResolvedValueOnce(undefined);

    const result = await reaper().sweep();

    expect(closeVendorSessionMock).toHaveBeenCalledWith('browser_use', 'vsid-1', 'tenant-1');
    expect(result.closed).toBe(1);
  });

  it('ends an open takeover hold BEFORE the vendor stops the browser, so the capture owner records no gap', async () => {
    withExpiredRows([expiredRow]);
    closeVendorSessionMock.mockResolvedValueOnce(undefined);

    await reaper().sweep();

    expect(endTakeoverHoldForCloseMock).toHaveBeenCalledWith('row-1');
    expect(endTakeoverHoldForCloseMock.mock.invocationCallOrder[0])
      .toBeLessThan(closeVendorSessionMock.mock.invocationCallOrder[0]);
  });

  it("marks it 'idle_timeout', which means the cost settled", async () => {
    withExpiredRows([expiredRow]);
    closeVendorSessionMock.mockResolvedValueOnce(undefined);

    await reaper().sweep();

    expect(closeSessionRowMock).toHaveBeenCalledWith('row-1', 'idle_timeout');
  });
});

describe('a session the reaper could NOT settle', () => {
  it("marks it 'failed' rather than leaving it indistinguishable", async () => {
    // The vendor was never told to stop, so nothing settled. Browser Use bills
    // the whole upfront window regardless, so this row is real unrecorded
    // money and has to be findable.
    withExpiredRows([expiredRow]);
    closeVendorSessionMock.mockRejectedValueOnce(new Error('vendor unreachable'));

    const result = await reaper().sweep();

    expect(closeReasons()).toEqual(['failed']);
    expect(result.failed).toBe(1);
  });

  it('still closes the row locally, so the admission slot is recovered', async () => {
    // Leaving it open would hold one of the plan's concurrent-browser slots
    // forever, which is worse than an unrecorded cost.
    withExpiredRows([expiredRow]);
    closeVendorSessionMock.mockRejectedValueOnce(new Error('vendor unreachable'));

    await reaper().sweep();

    expect(closeSessionRowMock).toHaveBeenCalledWith('row-1', 'failed');
  });
});

describe('nothing to do', () => {
  it('touches no session when none has expired', async () => {
    withExpiredRows([]);

    const result = await reaper().sweep();

    expect(closeVendorSessionMock).not.toHaveBeenCalled();
    expect(closeSessionRowMock).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: 0, failed: 0, byokUnreachable: 0 });
  });
});
