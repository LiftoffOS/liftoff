// Regenerate committed native-HRIS generated tool sets from their specs — reusing the EXACT
// codegen path (regen + emitJson) that codegen-conformance.test.ts verifies. Run after any
// spec-codegen change (e.g. adding responseSchema). Skips the uncommitted .large specs
// (oracle_hcm, workday_wws) — their generated files are left untouched.
//
// Usage: ts-node scripts/regen-all-generated.ts [connectorKey]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTORS, regen, sourceAvailable, ROOT } from '../src/catalog/__tests__/support/regen';
import { emitJson } from '../src/catalog/spec-codegen';

const only = process.argv[2];
for (const c of CONNECTORS) {
  if (only && c.key !== only) continue;
  if (!sourceAvailable(c)) { console.error(`skip ${c.key} (no committed source)`); continue; }
  const out = join(ROOT, 'src', 'catalog', 'generated', `${c.key}.generated.json`);
  writeFileSync(out, emitJson(regen(c)));
  console.error(`regen ${c.key}`);
}
