// REAL end-to-end: a migrated Postgres and the live Browser Use API.
//
// Excluded from the unit suite by testPathIgnorePatterns (.integration.test.ts)
// because it needs both. Run it deliberately:
//
//   createdb bu_e2e && DATABASE_URL=postgres://postgres@localhost:5432/bu_e2e \
//     bash scripts/ci/verify-migrations.sh
//   E2E_DB=postgres://postgres@localhost:5432/bu_e2e BU_KEY=<bu_live_...> \
//     npx jest browser-use-e2e
//
// It is the only check that covers the whole product path in one go: create a
// thread session, write the profile row behind its persistent login, drive the
// browser, and persist where it landed. Every bug in this area so far broke one
// link and left the others passing.
//
// setup.ts mocks the database pool globally for every suite
// (query -> { rows: [] }), so a test that means to touch a real database MUST
// override that mock. An earlier version of this file did not, and "passed"
// against empty result sets — which is exactly the silent-empty failure the
// product bugs in this area kept taking.
import { Pool } from 'pg';

const mockRealPool = new Pool({ connectionString: process.env.E2E_DB });
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => mockRealPool,
  getPoolForService: () => mockRealPool,
  pool: mockRealPool,
}));

const KEY = process.env.BU_KEY!;
jest.mock('../web-tool-secrets', () => ({
  getWebToolCredential: jest.fn().mockResolvedValue({ apiKey: KEY, connectorId: 'e2e', extra: {} }),
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set(['browser_use'])),
}));
jest.mock('../credential-pool', () => ({ markCredentialCooling: jest.fn(), markCredentialHealthy: jest.fn() }));
jest.mock('../byok-error-handler', () => ({ markConnectorErrored: jest.fn(), buildByokErrorMessage: () => 'm' }));
jest.mock('../../../browser-sessions/events', () => ({
  emitBrowserSessionEvent: jest.fn(), getBrowserSessionEmitter: jest.fn(),
}));

import { createBrowserUseSessionForThread, BrowserUseClient } from '../browser-use-client';
import * as vendorOps from '../../../browser-sessions/session-vendor-proxy';
import { persistCurrentUrl } from '../../../browser-sessions/current-url';

jest.setTimeout(180_000);
const T = '11111111-1111-1111-1111-111111111111';
const A = '22222222-2222-2222-2222-222222222222';
const TH = '33333333-3333-3333-3333-333333333333';
const O = '44444444-4444-4444-4444-444444444444';

// Clear this thread's rows first. Closing a session at the VENDOR does not
// mark the local row closed — the reaper does that in production — and
// web_sessions_one_active_per_thread (migration 378) correctly refuses a second
// live session on the same thread, so a re-run would fail on the previous run's
// leftovers. That the index bites here is the index working.
beforeAll(async () => {
  if (!RUNNABLE) return;
  await mockRealPool.query(`DELETE FROM web_sessions WHERE tenant_id=$1`, [T]);
  await mockRealPool.query(`DELETE FROM web_profiles WHERE tenant_id=$1`, [T]);
});

afterAll(async () => { if (RUNNABLE) await mockRealPool.end(); });

const RUNNABLE = !!process.env.E2E_DB && !!process.env.BU_KEY;
const itLive = RUNNABLE ? it : it.skip;

itLive('proves the pool override works before trusting anything else', async () => {
  const r = await mockRealPool.query('SELECT 1 AS n');
  expect(r.rows[0].n).toBe(1); // would be undefined under the global mock
});

itLive('creates a session + profile, navigates, and persists the URL', async () => {
  const session = await createBrowserUseSessionForThread({
    tenantId: T, agentId: A, threadId: TH, ownerAccountId: O,
  });
  console.log('session   :', session.vendor, '|', session.id.slice(0, 8));
  expect(session.vendor).toBe('browser_use');

  const prof = await mockRealPool.query(
    `SELECT vendor, profile_kind FROM web_profiles WHERE tenant_id=$1 AND agent_id=$2`, [T, A]);
  console.log('profile   :', prof.rows[0]);
  expect(prof.rows[0]).toMatchObject({ vendor: 'browser_use', profile_kind: 'pane' });

  try {
    await vendorOps.gotoUrl('browser_use', session.vendorSessionId, T, 'https://espn.com');
    const page = await vendorOps.getActivePage('browser_use', session.vendorSessionId, T);
    console.log('landed    :', page.url);
    await persistCurrentUrl(session.vendorSessionId, page.url);

    const row = await mockRealPool.query(
      `SELECT vendor_metadata->>'current_url' AS url FROM web_sessions WHERE vendor_session_id=$1`,
      [session.vendorSessionId]);
    console.log('persisted :', row.rows[0]?.url);
    expect(row.rows[0]?.url).toContain('espn.com');
  } finally {
    await vendorOps.closeSession('browser_use', session.vendorSessionId, T).catch(() => undefined);
    const p = await mockRealPool.query(`SELECT vendor_profile_id FROM web_profiles WHERE tenant_id=$1`, [T]);
    if (p.rows[0]) await new BrowserUseClient().deleteProfile(p.rows[0].vendor_profile_id, T).catch(() => undefined);
  }
});
