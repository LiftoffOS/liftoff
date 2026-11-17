// The web tables' vendor CHECKs must admit every vendor the code can write.
//
// runChain registers a waiter and an in-flight row for EVERY vendor in a chain
// before the vendor is called, so a vendor missing from those lists fails on
// its first call with a constraint violation and never reaches the vendor at
// all. The lists are hand-written copies of the WebVendor union, in SQL where
// the type system cannot see them, and have been missed once per vendor added:
// firecrawl (220), perplexity (221), tavily (231), exa (232), browser_use (384)
// — and then xai, openai and google, which failed every web_x_search from the
// day it shipped (406).
//
// web_sessions and web_profiles have the same shape of list and were not
// watched here, which is how web_profiles admitted two vendors while the
// Browserbase client wrote a third (417). The session row takes the same union
// as the admission tables; the profile row takes PROFILE_VENDORS, the list
// session-vendor-proxy.ts dispatches on, since only a vendor that can own a
// stored login writes one.
//
// Reading the lists out of the migrations is the only way to compare them
// without a database, and the unions are read out of their source the same
// way, because a type has no runtime value to compare against.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'migrations');

/** The WebVendor union, read out of types.ts. */
function webVendorUnion(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'integrations', 'web-fetch', 'types.ts'), 'utf8');
  const decl = /export type WebVendor\s*=([^;]*);/.exec(src);
  if (!decl) throw new Error('could not find the WebVendor union in types.ts');
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** PROFILE_VENDORS, read out of session-vendor-proxy.ts. */
function profileVendors(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'browser-sessions', 'session-vendor-proxy.ts'), 'utf8');
  const decl = /export const PROFILE_VENDORS[^=]*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) throw new Error('could not find PROFILE_VENDORS in session-vendor-proxy.ts');
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The value list from the LAST migration that defines `constraint` — the
 *  constraints are dropped and recreated each time they are widened, so only
 *  the newest definition is in effect. */
function currentConstraintValues(constraint: string): string[] {
  const defining = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes(`ADD CONSTRAINT ${constraint}`))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const newest = defining[defining.length - 1];
  if (!newest) throw new Error(`no migration defines ${constraint}`);
  const sql = readFileSync(join(MIGRATIONS, newest), 'utf8');
  const after = sql.slice(sql.lastIndexOf(`ADD CONSTRAINT ${constraint}`));
  const list = /vendor\s+IN\s*\(([^)]*)\)/i.exec(after);
  if (!list) throw new Error(`could not read the vendor list out of ${newest}`);
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('the admission tables admit every WebVendor', () => {
  const union = webVendorUnion().sort();

  it('reads a non-trivial union', () => {
    expect(union.length).toBeGreaterThan(5);
    expect(union).toContain('xai');
  });

  it.each(['web_inflight_requests_vendor_check', 'web_waiters_vendor_check', 'web_sessions_vendor_check'])(
    '%s matches the WebVendor union exactly',
    (constraint) => {
      // Both directions: a vendor missing from the constraint fails its first
      // call; one in the constraint the code cannot name is a vendor removed
      // without the schema following.
      expect(currentConstraintValues(constraint).sort()).toEqual(union);
    },
  );

  it('web_profiles_vendor_check matches PROFILE_VENDORS exactly', () => {
    const vendors = profileVendors().sort();
    expect(vendors.length).toBeGreaterThan(2);
    expect(currentConstraintValues('web_profiles_vendor_check').sort()).toEqual(vendors);
  });
});
