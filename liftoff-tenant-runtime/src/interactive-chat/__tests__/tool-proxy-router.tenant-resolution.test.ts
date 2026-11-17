// Every route in the tool-proxy router must resolve the tenant the same way.
//
// This file used to read tenancy two ways: GET/DELETE/PATCH took
// `req.query.tenantId || req.ctx?.tenantId`, while the three POST routes
// destructured `tenantId` out of the body and nothing else. Platform-backend
// sends the tenant as the `x-tenant-id` header on every call and does NOT put
// it in the body, so those three answered 400 on every request from the day
// they shipped — memory retrieval and memory save were dead for four months
// behind a breaker fallback that made it look like "no memories found".
//
// A split like that is invisible in review because each half reads correctly
// on its own. So assert the property directly: one resolver, used by every
// handler, and nobody reading `tenantId` off the body by hand.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'tool-proxy-router.ts'), 'utf8');

describe('tool-proxy-router tenant resolution (static contract)', () => {
  it('resolves the tenant through one helper that falls back to req.ctx', () => {
    expect(SRC).toMatch(/function tenantIdFor\(req: Request\)/);
    const body = SRC.slice(SRC.indexOf('function tenantIdFor'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toMatch(/req\.body\?\.tenantId/);
    expect(fn).toMatch(/req\.query\?\.tenantId/);
    expect(fn).toMatch(/req\.ctx\?\.tenantId/);
  });

  it('has every route handler resolve tenancy through that helper', () => {
    // Split the file into per-route regions, then require each to call the
    // helper. Counting call sites would pass while a new route quietly read
    // the body again.
    const routes = [...SRC.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
    expect(routes.length).toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    routes.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < routes.length ? (routes[i + 1].index ?? SRC.length) : SRC.length;
      const region = SRC.slice(start, end);
      if (!region.includes('tenantIdFor(req)')) {
        offenders.push(`${m[1].toUpperCase()} ${m[2]}`);
      }
    });

    expect(offenders).toEqual([]);
  });

  it('never destructures tenantId straight out of the request body', () => {
    // `const { tenantId, … } = req.body` is the exact shape that broke.
    const destructured = [...SRC.matchAll(/const\s*\{[^}]*\btenantId\b[^}]*\}\s*=\s*req\.body/g)];
    expect(destructured.map((m) => m[0])).toEqual([]);
  });
});
