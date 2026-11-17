import { DEFAULT_SERVICES, runIsolationCheck } from './cross-service-isolation.js';

describe('runIsolationCheck', () => {
  it('all denied → no violations', async () => {
    const conn = {
      probe: async () => ({ ok: false, errorCode: '42501', errorMessage: 'permission denied' }),
    };
    const result = await runIsolationCheck(conn, DEFAULT_SERVICES);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('one role accidentally allowed → violation recorded', async () => {
    const conn = {
      probe: async (role: string, db: string) => {
        if (role === 'billing_app' && db === 'workforce') {
          return { ok: true };
        }
        return { ok: false, errorCode: '42501', errorMessage: 'permission denied' };
      },
    };
    const result = await runIsolationCheck(conn, DEFAULT_SERVICES);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ role: 'billing_app', targetDb: 'workforce', observed: 'allowed' }),
    );
  });

  it('non-denial error → recorded as anomaly', async () => {
    const conn = {
      probe: async () => ({ ok: false, errorCode: '08001', errorMessage: 'network unreachable' }),
    };
    const result = await runIsolationCheck(conn, DEFAULT_SERVICES);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].observed).toMatch(/network unreachable/);
  });

  it('skips same-database probes (role cannot cross-access itself)', async () => {
    let probes = 0;
    const conn = {
      probe: async () => {
        probes++;
        return { ok: false, errorCode: '42501', errorMessage: 'permission denied' };
      },
    };
    await runIsolationCheck(conn, DEFAULT_SERVICES);
    // 6 services × 6 targets = 36; minus 6 same-db = 30.
    expect(probes).toBe(30);
  });
});
