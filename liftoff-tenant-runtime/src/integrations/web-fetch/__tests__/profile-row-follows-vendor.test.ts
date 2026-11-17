// A web_profiles row follows the vendor that last served its name.
//
// A profile name is vendor-agnostic by design (one row per tenant + name), and
// every session-vendor client reads its own id back with `vendor = '<self>'`.
// So an upsert that leaves `vendor` alone on conflict writes this vendor's id
// under the previous vendor's name, and from then on no client can read the
// row: this vendor mints a fresh profile on every spawn, the other tries to
// bind an id it never issued — say, a Steel profile id landing on a row still
// marked browser_use.
//
// Read out of the sources, because the rule lives in SQL text the type system
// cannot see, and a client added later must not be able to miss it.

import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENTS_WITH_PROFILE_ROWS = ['anchor-client.ts', 'browser-use-client.ts', 'browserbase-client.ts', 'steel-client.ts'];

describe('every profile upsert moves the row to the vendor that wrote it', () => {
  it.each(CLIENTS_WITH_PROFILE_ROWS)('%s', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const upserts = src.match(/INSERT INTO web_profiles[\s\S]*?ON CONFLICT \(tenant_id, profile_name\)[\s\S]*?DO UPDATE SET[\s\S]*?updated_at\s*= now\(\)/g) ?? [];
    expect(upserts.length).toBeGreaterThan(0);
    for (const upsert of upserts) {
      expect(upsert).toMatch(/DO UPDATE SET vendor\s+= EXCLUDED\.vendor,\s*vendor_profile_id = EXCLUDED\.vendor_profile_id/);
    }
  });
});
