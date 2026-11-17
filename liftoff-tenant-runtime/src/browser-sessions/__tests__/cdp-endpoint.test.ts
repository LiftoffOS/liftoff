/**
 * The CDP endpoint lookup that removes a vendor round trip from every browser
 * operation.
 *
 * Both CDP-driven vendors recorded the endpoint on the session row when they
 * created it, then asked the vendor for it again on every goto, screenshot,
 * page read and extract — a trip across the internet to learn something already
 * in our own Postgres. A measured goto ran 4.3s with no breakdown, which is how
 * you end up optimising whatever is easiest to reach.
 */

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
}));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: loggerMock }));

import { storedCdpUrl, PhaseTimer } from '../cdp-endpoint';

beforeEach(() => jest.clearAllMocks());

describe('storedCdpUrl', () => {
  it('returns the endpoint recorded when the session was created', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cdp_url: 'wss://vendor/session-1' }] });

    await expect(storedCdpUrl('vs-1')).resolves.toBe('wss://vendor/session-1');
  });

  it('reads only from a session that is still open', async () => {
    // A closed session's endpoint is dead. Handing it back would trade one
    // vendor round trip for a failed connect and a retry, which is worse.
    await storedCdpUrl('vs-1');

    expect(String(queryMock.mock.calls[0][0])).toContain('closed_at IS NULL');
  });

  it('returns null when the row carries no endpoint', async () => {
    // Ordinary, not exceptional: a session created before the column carried
    // one. The caller asks the vendor, exactly as it always did.
    queryMock.mockResolvedValueOnce({ rows: [{ cdp_url: null }] });

    await expect(storedCdpUrl('vs-1')).resolves.toBeNull();
  });

  it('returns null for an empty string rather than a useless endpoint', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ cdp_url: '' }] });

    await expect(storedCdpUrl('vs-1')).resolves.toBeNull();
  });

  it('returns null when there is no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(storedCdpUrl('vs-1')).resolves.toBeNull();
  });

  it('never fails the operation when the shortcut is unavailable', async () => {
    // This is an optimisation. A database hiccup must degrade to the old
    // behaviour, not take the browser down with it.
    queryMock.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(storedCdpUrl('vs-1')).resolves.toBeNull();
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe('PhaseTimer', () => {
  it('reports each phase separately alongside the total', async () => {
    // The point of the whole exercise: a 4.3s goto told us nothing about
    // whether the page or the connect was slow.
    const t = new PhaseTimer();
    t.mark('cdp_url');
    t.mark('connect');
    t.mark('operation');
    t.log('cdp_operation', { vendor: 'browser_use', op: 'gotoUrl' });

    const [ctx, event] = loggerMock.info.mock.calls[0];
    expect(event).toBe('cdp_operation');
    expect(ctx).toMatchObject({ vendor: 'browser_use', op: 'gotoUrl' });
    for (const k of ['cdp_url_ms', 'connect_ms', 'operation_ms', 'total_ms']) {
      expect(typeof ctx[k]).toBe('number');
    }
  });

  it('measures each phase from the end of the previous one', async () => {
    const t = new PhaseTimer();
    await new Promise(r => setTimeout(r, 30));
    t.mark('slow');
    t.mark('fast');
    t.log('cdp_operation', {});

    const ctx = loggerMock.info.mock.calls[0][0];
    expect(ctx.slow_ms).toBeGreaterThanOrEqual(25);
    // The second phase must not inherit the first one's elapsed time.
    expect(ctx.fast_ms).toBeLessThan(25);
  });
});
