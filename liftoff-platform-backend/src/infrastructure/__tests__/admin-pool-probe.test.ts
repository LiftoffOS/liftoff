// Admin pool BYPASSRLS probe — M1 audit finding.
//
// Verifies that probeAdminPoolBypassRls:
//   - throws when LIFTOFF_REQUIRE_ADMIN_BYPASSRLS=true and current_user lacks BYPASSRLS
//   - logs a warning but does NOT throw when enforcement is not opted in
//   - is cached: runs the SELECT only once per process
//
// Note: enforcement is OPT-IN (not auto-triggered on NODE_ENV=production)
// because Cloud Run sets NODE_ENV=production for every environment. The
// probe only enforces when FORCE RLS is actually rolled out — operators set
// LIFTOFF_REQUIRE_ADMIN_BYPASSRLS=true at that point.

jest.mock('../logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// We don't want the database module to actually run initDatabase or read
// secrets. Mock secrets to avoid any side-effects on import.
jest.mock('../secrets', () => ({
  getDbPassword: jest.fn(async () => 'unused'),
}));

import { probeAdminPoolBypassRls, _resetAdminPoolStateForTests } from '../database';
import { log } from '../logging';

type FakePool = { query: jest.Mock };

function fakePoolReturning(rows: Array<{ rolbypassrls: boolean; current_user: string }>): FakePool {
  return { query: jest.fn().mockResolvedValueOnce({ rows, rowCount: rows.length }) };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetAdminPoolStateForTests();
  jest.clearAllMocks();
  // Reset env between tests.
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('probeAdminPoolBypassRls', () => {
  it('throws when LIFTOFF_REQUIRE_ADMIN_BYPASSRLS=true and role lacks BYPASSRLS', async () => {
    process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = 'true';
    const pool = fakePoolReturning([{ rolbypassrls: false, current_user: 'liftoff_user' }]);
    await expect(probeAdminPoolBypassRls(pool as never)).rejects.toThrow(/BYPASSRLS/);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_pool_probe_failed' }),
      expect.any(String),
    );
  });

  it('does NOT auto-trigger on NODE_ENV=production alone (Cloud Run sets this for dev too)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS;
    const pool = fakePoolReturning([{ rolbypassrls: false, current_user: 'liftoff_app' }]);
    await expect(probeAdminPoolBypassRls(pool as never)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_pool_probe_warning' }),
      expect.any(String),
    );
  });

  it('logs a warning but does not throw when not opted in', async () => {
    delete process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS;
    const pool = fakePoolReturning([{ rolbypassrls: false, current_user: 'dev_user' }]);
    await expect(probeAdminPoolBypassRls(pool as never)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_pool_probe_warning' }),
      expect.any(String),
    );
  });

  it('passes silently when BYPASSRLS is set', async () => {
    process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = 'true';
    const pool = fakePoolReturning([{ rolbypassrls: true, current_user: 'liftoff_admin' }]);
    await expect(probeAdminPoolBypassRls(pool as never)).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_pool_probe_ok' }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('only runs the SELECT once per process (cached)', async () => {
    process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = 'true';
    const pool: FakePool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ rolbypassrls: true, current_user: 'liftoff_admin' }],
          rowCount: 1,
        }),
    };
    await probeAdminPoolBypassRls(pool as never);
    await probeAdminPoolBypassRls(pool as never);
    await probeAdminPoolBypassRls(pool as never);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('treats missing pg_roles row as a probe failure when enforcement is on', async () => {
    process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = 'true';
    const pool = fakePoolReturning([]);
    await expect(probeAdminPoolBypassRls(pool as never)).rejects.toThrow(/current_user not found/);
  });

  // BLK-2: prior implementation flagged the probe as completed via a
  // `finally` clause even on throw, causing the *next* call to silently
  // return success while pointing at a broken pool. The fix moves the
  // `adminPoolProbed = true` assignment to AFTER the success path.
  it('BLK-2: when enforcement is on, a failing probe re-throws on the next call (does not silently succeed)', async () => {
    process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = 'true';
    // Two separate query() responses — both indicating no BYPASSRLS.
    const pool: FakePool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ rolbypassrls: false, current_user: 'liftoff_user' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ rolbypassrls: false, current_user: 'liftoff_user' }],
          rowCount: 1,
        }),
    };

    await expect(probeAdminPoolBypassRls(pool as never)).rejects.toThrow(/BYPASSRLS/);
    // The cached flag must NOT have been set — the next call must re-probe
    // and re-throw rather than silently returning.
    await expect(probeAdminPoolBypassRls(pool as never)).rejects.toThrow(/BYPASSRLS/);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
