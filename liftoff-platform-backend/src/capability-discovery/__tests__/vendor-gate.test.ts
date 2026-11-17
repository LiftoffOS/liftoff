// The operator's vendor switch: one row in disabled_connectors takes a
// platform vendor out of the offer step and out of execution, and a read
// that fails keeps the last known answer rather than flipping anything.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({ getPool: jest.fn() }));

import { getPool } from '../../infrastructure/database';
import {
  _resetVendorGateCache,
  isCooling,
  operatorCooldownView,
  parkCredential,
  platformVendorSwitchedOff,
  platformVendorSwitchedOffSync,
  switchedOffVendors,
} from '../vendor-gate';

const queryMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  _resetVendorGateCache();
  (getPool as jest.Mock).mockReturnValue({ query: queryMock });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the vendor switch', () => {
  it('reads the switched-off set once per window and answers from it', async () => {
    queryMock.mockResolvedValue({ rows: [{ connector_type: 'apify' }] });

    expect(await platformVendorSwitchedOff('apify')).toBe(true);
    expect(await platformVendorSwitchedOff('tikhub')).toBe(false);
    expect(platformVendorSwitchedOffSync('apify')).toBe(true);
    // One refresh is two reads — the switch set and the live cooldowns — and
    // the second call within the window makes neither.
    const switchReads = () => queryMock.mock.calls.filter((c) => String(c[0]).includes('disabled_connectors')).length;
    expect(switchReads()).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(31_000);
    queryMock.mockResolvedValue({ rows: [] });
    expect(await platformVendorSwitchedOff('apify')).toBe(false);
    expect(switchReads()).toBe(2);
  });

  it('answers "not off" before any read, synchronously', () => {
    expect(platformVendorSwitchedOffSync('apify')).toBe(false);
  });

  it('keeps the last known set when the read fails', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ connector_type: 'strale' }] });
    expect(await switchedOffVendors()).toEqual(new Set(['strale']));

    jest.advanceTimersByTime(31_000);
    queryMock.mockRejectedValueOnce(new Error('db down'));
    expect(await switchedOffVendors()).toEqual(new Set(['strale']));
  });

  it('is empty, not thrown, when the first read fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    expect(await switchedOffVendors()).toEqual(new Set());
  });
});

// The cooldown: a credential that just failed at account level is parked by
// its own key, the platform key for everyone and a workspace's connector for
// that workspace, and lapses on its own timestamp whatever the cache did.
describe('the credential cooldown', () => {
  const NOW = new Date('2026-09-18T10:00:00Z').getTime();
  const inMinutes = (m: number) => new Date(NOW + m * 60_000);

  /** The two queries a refresh makes, answered in order: the switch set, then
   *  the live cooldown rows. */
  function answerRefresh(off: string[], cooling: Array<{ credential_ref: string; expires_at: Date }>): void {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('disabled_connectors')) return { rows: off.map((connector_type) => ({ connector_type })) };
      if (sql.includes('FROM vendor_cooldowns')) return { rows: cooling };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    jest.setSystemTime(NOW);
  });

  it('a platform-key row parks the platform credential and no workspace connector of the type', async () => {
    answerRefresh([], [{ credential_ref: 'internal:tikhub', expires_at: inMinutes(10) }]);
    await switchedOffVendors();
    expect(isCooling('internal:tikhub')).toBe(true);
    expect(isCooling('connector:c-1')).toBe(false);
    expect(isCooling('internal:strale')).toBe(false);
    // The switch and the cooldown are two answers: a parked vendor is not "off".
    expect(platformVendorSwitchedOffSync('tikhub')).toBe(false);
  });

  it('a connector row parks that connector only — not the platform key, not a sibling connector of the same type', async () => {
    answerRefresh([], [{ credential_ref: 'connector:c-1', expires_at: inMinutes(10) }]);
    await switchedOffVendors();
    expect(isCooling('connector:c-1')).toBe(true);
    expect(isCooling('connector:c-2')).toBe(false);
    expect(isCooling('internal:apify')).toBe(false);
  });

  it('expiry is honoured on every read, including while a refresh keeps failing', async () => {
    answerRefresh([], [{ credential_ref: 'internal:tikhub', expires_at: inMinutes(2) }]);
    await switchedOffVendors();
    expect(isCooling('internal:tikhub')).toBe(true);

    // The cache window passes and the database is down: the last rows stand…
    jest.setSystemTime(NOW + 31_000);
    queryMock.mockRejectedValue(new Error('db down'));
    await switchedOffVendors();
    expect(isCooling('internal:tikhub')).toBe(true);

    // …and still lapse on their own timestamp, with the database still down.
    jest.setSystemTime(NOW + 2 * 60_000 + 1);
    await switchedOffVendors();
    expect(isCooling('internal:tikhub')).toBe(false);
  });

  it('a local park is visible on this instance at once, before any refresh and even when the write fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    await parkCredential({ credentialRef: 'connector:c-9', connectorType: 'apify', tenantId: 't1', reason: 'auth', durationMs: 60_000 });
    expect(isCooling('connector:c-9')).toBe(true);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO vendor_cooldowns'), [
      'connector:c-9', 'apify', 't1', 'auth', NOW + 60_000,
    ]);
    jest.setSystemTime(NOW + 60_001);
    expect(isCooling('connector:c-9')).toBe(false);
  });

  it('an in-flight refresh cannot overwrite a newer local park', async () => {
    // A refresh that read the table BEFORE the park landed answers with no
    // rows for it; the park must survive that refresh completing.
    let releaseRefresh: (v: { rows: unknown[] }) => void = () => undefined;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('disabled_connectors')) return { rows: [] };
      if (sql.includes('FROM vendor_cooldowns')) return new Promise((resolve) => { releaseRefresh = resolve; });
      return { rows: [] };
    });
    const refreshing = switchedOffVendors();
    await Promise.resolve();
    await parkCredential({ credentialRef: 'internal:strale', connectorType: 'strale', tenantId: null, reason: 'payment', durationMs: 10 * 60_000 });
    expect(isCooling('internal:strale')).toBe(true);
    releaseRefresh({ rows: [] });
    await refreshing;
    expect(isCooling('internal:strale')).toBe(true);
    // And a refresh that DOES carry the row, with an older expiry, keeps the newer one.
    jest.setSystemTime(NOW + 31_000);
    answerRefresh([], [{ credential_ref: 'internal:strale', expires_at: inMinutes(1) }]);
    await switchedOffVendors();
    jest.setSystemTime(NOW + 5 * 60_000);
    expect(isCooling('internal:strale')).toBe(true);
  });

  it('the operator view lists platform parks individually and workspace parks as counts, with no ids', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { credential_ref: 'internal:tikhub', connector_type: 'tikhub', reason: 'payment', expires_at: inMinutes(9) },
        { credential_ref: 'connector:c-1', connector_type: 'apify', reason: 'auth', expires_at: inMinutes(4.5) },
        { credential_ref: 'connector:c-2', connector_type: 'apify', reason: 'auth', expires_at: inMinutes(4.2) },
        { credential_ref: 'connector:c-3', connector_type: 'apify', reason: 'auth', expires_at: inMinutes(9) },
      ],
    });
    const view = await operatorCooldownView();
    expect(view).toEqual({
      platform: [{ connectorType: 'tikhub', scope: 'platform', reason: 'payment', expiresAt: inMinutes(9).toISOString() }],
      workspace: [
        { connectorType: 'apify', scope: 'workspace', reason: 'auth', expiresWithinMinutes: 5, count: 2 },
        { connectorType: 'apify', scope: 'workspace', reason: 'auth', expiresWithinMinutes: 9, count: 1 },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/c-1|c-2|c-3|tenant/);
  });
});
