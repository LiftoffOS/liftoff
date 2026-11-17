// AUDIT + FIX-GEN: compares the actual RUNTIME native-HRIS tool set
// (NATIVE_HRIS_FUNCTIONS = mergeTools(hand-authored, generated)) against what
// migration 276 seeded, and emits migration 277 for the delta:
//   Gap A — runtime tools with NO seed row (hand-authored curated + passthrough)
//   Gap B — seeded by name but the runtime CATEGORIES differ (a real
//           cross-connector classification conflict the global tool_name key
//           can't hold). A hash-only diff with MATCHING categories is benign and
//           deliberately NOT emitted: the runtime lookup is by tool_name and
//           never consults tool_description_hash, so re-seeding it would only
//           churn an inert column (and whack-a-mole the other connector's row).
// Run: NATIVE_HRIS_CONNECTORS=... ts-node ... scripts/audit-hris-classification.ts [outSqlPath]
import crypto from 'crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_HRIS_FUNCTIONS } from '../src/catalog/native-hris-functions.js';

// Path to the already-applied seed migration to diff against. Override with
// SEED_MIGRATION_PATH; defaults to the sibling platform-backend checkout.
const MIGRATION = process.env.SEED_MIGRATION_PATH
  ?? join(__dirname, '..', '..', 'liftoff-platform-backend', 'migrations', '276_native_hris_tool_classification.sql');
const OUT = process.argv[2];
const hashDesc = (d: string) => crypto.createHash('sha256').update(d).digest('hex').substring(0, 12);

// Baseline is optional: for a connector that has NO prior seed (e.g. the
// static_oauth pair gusto/rippling, which have no migration-276 equivalent),
// point SEED_MIGRATION_PATH at an absent/empty file — every runtime tool then
// falls into Gap A (unseeded) and the script emits a fresh FULL seed.
let sql = '';
try { sql = readFileSync(MIGRATION, 'utf8'); } catch { /* no baseline on disk → full seed */ }
const seeded = new Map<string, { conn: string; hash: string; cats: string[] }>();
const re = /\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(ARRAY\[[^\]]*\][^,]*)/g;
let m: RegExpExecArray | null;
while ((m = re.exec(sql)) !== null) {
  const scats = [...m[4].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  seeded.set(m[1], { conn: m[2], hash: m[3], cats: scats });
}
const normCats = (c: string[]) => JSON.stringify([...c].sort());

// Financial stems (same policy as migration 276): pay/comp/tax/bank paths → +financialActions.
const FIN = ['compensation', 'remuneration', 'salar', 'payroll', 'payslip', 'paystub', 'paycheck',
  'payrate', 'payband', 'payment', 'payout', 'wage', 'bonus', 'stipend', 'garnish', 'reimburs',
  'deduction', 'earning', 'invoice', 'refund', 'disburse', 'pension', 'contribution', 'benefit',
  'allowance', 'withhold', 'tax', 'bank', 'equity', 'stock', 'award', 'payadvance',
  'payadjust', 'calculationcard', 'calculationentr'];
// Fail-secure set for the {vendor}_native_request passthrough: it can hit ANY endpoint
// (read OR destructive OR financial OR outbound), so it must ALWAYS require HITL.
const PASSTHROUGH_CATS = ['dataChanges', 'financialActions', 'customerCommunication'];

function cats(fn: { name: string; entityType?: string; categories: string[] }): string[] {
  if (fn.entityType === 'native') return PASSTHROUGH_CATS;
  if (fn.categories.length === 1 && fn.categories[0] === 'read') return [];
  const fin = FIN.some((s) => (fn.name + ' ' + (fn.entityType ?? '')).toLowerCase().includes(s));
  return fin ? ['financialActions', 'dataChanges'] : ['dataChanges'];
}
const arr = (c: string[]) => (c.length === 0 ? 'ARRAY[]::TEXT[]' : `ARRAY[${c.map((x) => `'${x}'`).join(',')}]::TEXT[]`);

// Connector scope: batch-1 four by default. Override with a CSV env var —
// HRIS_CLASSIFICATION_CONNECTORS or AUDIT_HRIS_CONNECTORS — to seed another batch
// (e.g. batch 2's nine, or the gusto/rippling static_oauth pair) against a chosen
// SEED_MIGRATION_PATH. For a batch with no migration-276 baseline (gusto/rippling),
// leave SEED_MIGRATION_PATH empty/absent to emit a fresh full seed.
const HRIS_CONNECTORS_OVERRIDE = process.env.HRIS_CLASSIFICATION_CONNECTORS ?? process.env.AUDIT_HRIS_CONNECTORS;
const CONNECTORS = HRIS_CONNECTORS_OVERRIDE
  ? HRIS_CONNECTORS_OVERRIDE.split(',').map((s) => s.trim()).filter(Boolean)
  : ['namely', 'workday', 'oracle_hcm', 'sap_successfactors'];
const rowsByConn: Record<string, string[]> = {};
// The classification cache PK is GLOBAL by tool_name, and the hand-authored sets
// reuse generic names across connectors (list_workers/get_worker/... in both
// workday & oracle). The runtime lookup is by tool_name only, so one row per name
// serves every connector — which is CORRECT as long as every connector classifies
// a shared name into the SAME categories (the category-conflict check below proves
// this holds; if it ever fails, that name needs per-connector keying, not a seed).
// Dedupe globally to keep the INSERT's ON CONFLICT valid.
const emitted = new Set<string>();
let gapA = 0, gapBcat = 0, gapBhashOnly = 0, collisionsDropped = 0;
for (const conn of CONNECTORS) {
  rowsByConn[conn] = [];
  for (const fn of NATIVE_HRIS_FUNCTIONS[conn]) {
    const h = hashDesc(fn.description);
    const runtimeCats = cats(fn);
    const s = seeded.get(fn.name);
    const isGapA = !s;
    // A hash mismatch only MATTERS when categories also differ — a real conflict
    // the global key can't hold. Hash-only diffs (same categories) are benign:
    // count them for visibility but do NOT emit (see header).
    const catConflict = !!s && normCats(s.cats) !== normCats(runtimeCats);
    if (!isGapA && !catConflict) {
      if (s && s.hash !== h) gapBhashOnly++;
      continue;
    }
    if (isGapA) gapA++; else gapBcat++;
    if (emitted.has(fn.name)) { collisionsDropped++; continue; }
    emitted.add(fn.name);
    rowsByConn[conn].push(`  ('${fn.name}', '${conn}', '${h}', ${arr(runtimeCats)}, NULL, 'native-hris-runtime-v1', false, NULL)`);
  }
  console.log(`${conn}: delta rows = ${rowsByConn[conn].length}`);
}
console.log(`TOTAL delta: Gap A (unseeded)=${gapA}, Gap B category-conflict (REAL, emitted)=${gapBcat}, Gap B hash-only (benign, not emitted)=${gapBhashOnly}, cross-connector-name-collisions-deduped=${collisionsDropped}`);

if (OUT) {
  const baselineNote = sql ? 'delta over the baseline at SEED_MIGRATION_PATH' : 'fresh full seed (no baseline)';
  let out = `-- Native HRIS classification seeds for: ${CONNECTORS.join(', ')} (${baselineNote}).
-- Seeds tool_classification_cache for the RUNTIME native tool set each agent sees:
-- NATIVE_HRIS_FUNCTIONS[type] = mergeTools(hand-authored <VENDOR>_FUNCTIONS, generated).
-- Hashes are sha256(runtime description).slice(0,12) so the runtime lookup is a cache
-- HIT (no fallback to LLM classification). Categories:
--   read -> []; write/destructive -> ['dataChanges'] (+ 'financialActions' on
--   pay/comp/tax/bank paths); {vendor}_native_request passthrough -> always-HITL
--   ['dataChanges','financialActions','customerCommunication'] (can call any endpoint).
-- Regenerate: HRIS_CLASSIFICATION_CONNECTORS=<csv> (or AUDIT_HRIS_CONNECTORS)
-- SEED_MIGRATION_PATH=<seed> scripts/audit-hris-classification.ts <out.sql>.
`;
  for (const conn of CONNECTORS) {
    if (!rowsByConn[conn].length) continue;
    out += `\nINSERT INTO tool_classification_cache\n  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)\nVALUES\n`;
    out += rowsByConn[conn].join(',\n') + '\n';
    out += `ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE\n  SET categories = EXCLUDED.categories,\n      integration_type = EXCLUDED.integration_type,\n      tool_description_hash = EXCLUDED.tool_description_hash,\n      reviewed_by = EXCLUDED.reviewed_by,\n      classified_at = NOW();\n`;
  }
  writeFileSync(OUT, out);
  console.log('wrote', OUT);
}