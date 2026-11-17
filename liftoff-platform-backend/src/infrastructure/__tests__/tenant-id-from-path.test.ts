// The tenant id a `/tenant/:tenantId` route carries in its path.
//
// tenantAuthMiddleware is attached as `app.use('/api/x', guard, xRouter)`, and
// Express populates req.params from the MOUNT path only — a `:tenantId` on a
// route INSIDE the router is invisible to it. So on every route shaped
// `/tenant/:tenantId`, params, query and body were all undefined, the guard
// asked getMembership(undefined, actor), and refused the caller 403 for their
// own tenant.
//
// It failed for everyone equally, which is why it read as "this endpoint needs
// other permissions" rather than as a bug. Five routers and eighteen routes were
// affected. It surfaced through /api/feature-flags/tenant/:tenantId, which the
// browser-pane affordance reads: it 403'd on every page load, so the flags query
// had no data, so every workspace without its own browser connector was shown no
// browser at all.

import { readFileSync } from 'fs';
import { join } from 'path';
import { tenantIdFromPath } from '../middleware';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

describe('tenantIdFromPath', () => {
  it('reads the id a /tenant/:tenantId route carries', () => {
    expect(tenantIdFromPath(`/api/feature-flags/tenant/${TENANT}`)).toBe(TENANT);
  });

  it('reads it when more path follows', () => {
    expect(tenantIdFromPath(`/api/deployments/tenant/${TENANT}/history`)).toBe(TENANT);
  });

  it('ignores the query string', () => {
    expect(tenantIdFromPath(`/api/feature-flags/tenant/${TENANT}?refresh=1`)).toBe(TENANT);
  });

  it('is case-insensitive about the uuid', () => {
    expect(tenantIdFromPath(`/api/x/tenant/${TENANT.toUpperCase()}`)).toBe(TENANT.toUpperCase());
  });
});

describe('what it deliberately does NOT claim', () => {
  it('ignores a uuid that is not behind /tenant/', () => {
    // Anchored on the segment rather than "find a uuid anywhere", so a route
    // carrying some OTHER id cannot be mistaken for a tenancy claim.
    expect(tenantIdFromPath(`/api/internal-agents/${TENANT}`)).toBeUndefined();
    expect(tenantIdFromPath(`/api/threads/${TENANT}/messages`)).toBeUndefined();
  });

  it('ignores a non-uuid after /tenant/', () => {
    expect(tenantIdFromPath('/api/feature-flags/tenant/me')).toBeUndefined();
    expect(tenantIdFromPath('/api/feature-flags/tenant/12345')).toBeUndefined();
  });

  it('answers undefined for nothing at all', () => {
    expect(tenantIdFromPath(undefined)).toBeUndefined();
    expect(tenantIdFromPath('')).toBeUndefined();
    expect(tenantIdFromPath('/api/feature-flags')).toBeUndefined();
  });
});

describe('it does not change who is authorised', () => {
  it('is only a CLAIM — the membership check is what authorises it', () => {
    // Reading the id from the path is exactly as safe as reading it from
    // params or the query string: all three are caller-supplied. This test
    // exists to state that, so nobody later mistakes the fallback for a
    // trust boundary.
    expect(tenantIdFromPath(`/api/x/tenant/${TENANT}`)).toBe(TENANT);
  });
});

describe('the guard actually USES it', () => {
  // The helper being correct is not the property that matters: the bug was that
  // the guard never saw the id. Source-scanned because tenantAuthMiddleware
  // dynamic-imports three services and talks to the database, so exercising it
  // here would test the mocks rather than the wiring.
  const SRC = readFileSync(join(__dirname, '..', 'middleware.ts'), 'utf8');

  it('resolves the tenant id from the path as well as params, query and body', () => {
    const block = SRC.slice(SRC.indexOf('const tenantId = req.params.tenantId'));
    expect(block.slice(0, 300)).toMatch(/tenantIdFromPath\(req\.originalUrl\)/);
  });

  it('keeps the three original sources ahead of it', () => {
    // The path is a fallback, not a replacement: a route that already passes the
    // id explicitly must keep winning, so a nested /tenant/<uuid> segment cannot
    // override what the caller actually addressed.
    const block = SRC.slice(SRC.indexOf('const tenantId = req.params.tenantId'), SRC.indexOf('const tenantId = req.params.tenantId') + 300);
    const iParams = block.indexOf('req.params.tenantId');
    const iQuery = block.indexOf('req.query.tenantId');
    const iBody = block.indexOf('?.tenantId');
    const iPath = block.indexOf('tenantIdFromPath');
    expect(iParams).toBeLessThan(iQuery);
    expect(iQuery).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iPath);
  });
});
