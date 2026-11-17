/**
 * A pane browser has to bill somebody.
 *
 * Before this path existed, not one pane tool recorded a cost: start, navigate,
 * run_browser_task and close between them contained no recordUsage, no
 * publishWebToolEvent and no cost figure at all. That was survivable while every
 * browser was BYOK, because the row would have been a zero-OU analytics entry.
 * It stopped being survivable when the platform took a Browser Use key, because
 * the hours are then ours to pay and the charging rule has nothing to act on.
 */

const publishWebToolEventMock = jest.fn().mockResolvedValue(true);
jest.mock('../../integrations/web-fetch/event-publisher', () => ({
  publishWebToolEvent: (...a: unknown[]) => publishWebToolEventMock(...a),
}));

const recordUsageMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: (...a: unknown[]) => recordUsageMock(...a) },
}));

const poolQueryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => poolQueryMock(...a) }),
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: loggerMock }));

import { recordSettledSessionCost, sessionCostIdempotencyKey } from '../session-cost';
import { NO_AGENT_SENTINEL } from '../types';

/** A settled session as a vendor client hands it over: the money already
 *  converted to USD, and the instant the vendor says it ended. */
const settled = (over: Record<string, unknown> = {}) => ({
  vendor: 'browser_use',
  tenantId: 't1',
  vendorSessionId: 'vs-1',
  costUsd: 0.0005,
  settledAt: new Date('2026-09-04T10:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  poolQueryMock.mockResolvedValue({ rows: [{ agent_id: 'agent-1', thread_id: 'thread-1' }] });
});

describe('a settled session', () => {
  it('records the vendor cost against the agent that held it', async () => {
    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    // Both meters are summed: proxy egress is charged on EVERY session whether
    // or not one was asked for, and on a heavy page it overtakes the hourly line.
    expect(publishWebToolEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      agentId: 'agent-1',
      threadId: 'thread-1',
      connector: 'browser_use',
      costUsd: 0.0005,
    }));
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'agent-1',
    }));
  });

  it('carries the funding onto BOTH ledgers', async () => {
    // They are not alternatives: the event is the real-time path and the usage
    // ledger is the poll that backstops it. Funding on only one means the charge
    // depends on which path arrives first.
    await recordSettledSessionCost({ ...settled(), funding: 'platform' });
    expect(publishWebToolEventMock.mock.calls[0][0].metadata.funding).toBe('platform');
    expect(recordUsageMock.mock.calls[0][0].metadata.funding).toBe('platform');
  });

  it("reports a workspace's own key as tenant_key so it is never charged twice", async () => {
    await recordSettledSessionCost({ ...settled(), funding: 'tenant_key' });
    expect(publishWebToolEventMock.mock.calls[0][0].metadata.funding).toBe('tenant_key');
  });

  it("stamps the VENDOR's finish time, not now()", async () => {
    // The control plane's uniqueness index for these rows includes occurred_at,
    // so a drifting timestamp slips a duplicate past it. A session settled twice
    // must produce the same instant both times.
    await recordSettledSessionCost({ ...settled(), funding: 'platform' });
    expect(publishWebToolEventMock.mock.calls[0][0].occurredAt)
      .toBe('2026-09-04T10:00:00.000Z');
  });

  it('keys on the vendor session id so a double close bills once', async () => {
    // The agent's web_session_close and the reaper's sweep settle the SAME
    // session moments apart, and both reach this function.
    await recordSettledSessionCost({ ...settled(), funding: 'platform' });
    expect(publishWebToolEventMock.mock.calls[0][0].idempotencyKey)
      .toBe(sessionCostIdempotencyKey('browser_use', 'vs-1'));
    expect(sessionCostIdempotencyKey('browser_use', 'vs-1'))
      .toBe(sessionCostIdempotencyKey('browser_use', 'vs-1'));
  });
});

describe('a session that cannot be settled', () => {
  it('records NOTHING rather than an unsettled figure', async () => {
    // A vendor reports a final cost only once the session has ended; before
    // that the figures are a running estimate or an upfront reservation, not a
    // bill. Publishing one would charge for minutes nobody used AND burn the
    // idempotency key against the real figure arriving later.
    await recordSettledSessionCost({
      ...settled({ settledAt: null }), funding: 'platform',
    });
    expect(publishWebToolEventMock).not.toHaveBeenCalled();
    expect(recordUsageMock).not.toHaveBeenCalled();
    // Loud, because the money was spent and we do not know how much.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'browser_session_cost_unsettled' }),
      expect.any(String),
    );
  });

  it('records nothing when the vendor could not be reached at all', async () => {
    await recordSettledSessionCost({
      ...settled({ costUsd: null }), funding: 'platform',
    });
    expect(publishWebToolEventMock).not.toHaveBeenCalled();
  });
});

describe('a session with nothing to attribute it to', () => {
  it('refuses to write an unattributed ledger row', async () => {
    // A row with a null agent lands in reporting as spend belonging to nobody,
    // which is worse than a logged gap somebody can go and look at.
    poolQueryMock.mockResolvedValue({ rows: [] });
    await recordSettledSessionCost({ ...settled(), funding: 'platform' });
    expect(publishWebToolEventMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'browser_session_cost_unattributed' }),
      expect.any(String),
    );
  });
});

describe('a cost figure that is not a usable number', () => {
  it('refuses NaN rather than publishing it', async () => {
    // The failure this exists for. Browser
    // Use sends browserCost and proxyCost as JSON STRINGS to keep precision, so
    // `(a ?? 0) + (b ?? 0)` concatenated them into
    // "0.00066666666666666666666666666660.00000289641320705413818359375".
    // That became NaN at the first arithmetic: Math.round(NaN) nulled the usage
    // ledger's cost, and the control plane's allocator computed !(NaN > 0),
    // assigned nothing and ACKed with a 200. The session billed nobody and
    // every surface reported success.
    await recordSettledSessionCost({ ...settled({ costUsd: Number.NaN }), funding: 'platform' });
    expect(publishWebToolEventMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'browser_session_cost_unsettled' }),
      expect.any(String),
    );
  });

  it('refuses an unparseable settle instant', async () => {
    await recordSettledSessionCost({
      ...settled({ settledAt: new Date('not a date') }), funding: 'platform',
    });
    expect(publishWebToolEventMock).not.toHaveBeenCalled();
  });

  it('still records a genuinely free session', async () => {
    // Zero is a real answer and must not be confused with unreadable. The
    // control plane no-ops a zero-cost event, but the usage ledger row is what
    // says a session happened at all.
    await recordSettledSessionCost({ ...settled({ costUsd: 0 }), funding: 'platform' });
    expect(publishWebToolEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0 }),
    );
  });
});

/** The three platform assistants share one identity — the no-agent sentinel —
 *  because none of them has an agent row. Without a second dimension their
 *  browser spend is one indistinguishable lump, filed against an agent the
 *  customer does not have. */
describe('a session a platform assistant held', () => {
  const withAssistant = (assistant: string | null, agentId = NO_AGENT_SENTINEL) =>
    poolQueryMock.mockResolvedValue({
      rows: [{
        agent_id: agentId,
        thread_id: 'thread-1',
        vendor_metadata: assistant ? { assistant } : {},
      }],
    });

  it('names which assistant it was, so the three can be told apart', async () => {
    withAssistant('liftoff');

    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    expect(publishWebToolEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'liftoff' }),
    );
  });

  it('carries it on the ledger too, since both feeds reach billing', async () => {
    // A figure on only one of them means the charge depends on which path
    // arrives first.
    withAssistant('team_plan');

    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ assistant: 'team_plan' }),
    }));
  });

  it('sends the sentinel to the ledger rather than null', async () => {
    // usage_events.agent_id is NOT NULL, and the failing insert is swallowed by
    // a .catch that only warns — so a null here would drop the backstop feed
    // silently, for exactly the sessions this dimension exists to track.
    // strictNullChecks is off in this repo, so nothing would have complained.
    withAssistant('insights');

    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: NO_AGENT_SENTINEL }),
    );
  });

  it('still records a session whose row carries no assistant label', async () => {
    // Labelling is best-effort at spawn. An unlabelled session is worth less in
    // reporting; dropping its cost entirely would be worth nothing at all.
    withAssistant(null);

    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    expect(publishWebToolEventMock).toHaveBeenCalled();
    expect(publishWebToolEventMock.mock.calls[0][0]).not.toHaveProperty('purpose', expect.anything());
  });

  it('records a TEAM agent unchanged, with no purpose', async () => {
    withAssistant(null, 'agent-1');

    await recordSettledSessionCost({ ...settled(), funding: 'platform' });

    expect(publishWebToolEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
    );
  });
});
