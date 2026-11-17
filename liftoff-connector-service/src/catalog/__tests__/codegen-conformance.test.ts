// A. Codegen conformance / no-drift.
// Proves each committed generated tool set is a faithful, up-to-date render of the
// vendor's own spec: a fresh regen equals the committed JSON byte-for-byte (no drift),
// every documented operation became a tool, names are unique.
//
// The generated sets are JSON DATA (not imported modules), so this test READS them —
// it never transpiles them. Heavy work (parse/regen) is gated on `sourceAvailable`:
// the small connectors' specs are committed (checked everywhere), while the giant
// specs (oracle_hcm, workday_wws) live under the gitignored specs/.large and are
// absent in CI, where those two get a cheap existence check only.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTORS, regen, operationCount, sourceAvailable, ROOT } from './support/regen';
import { emitJson } from '../spec-codegen';

const genPath = (key: string) => join(ROOT, 'src', 'catalog', 'generated', `${key}.generated.json`);
const VALID_CATEGORIES = new Set(['read', 'write', 'destructive', 'outbound', 'sensitive']);
interface Tool { name: string; entityType: string; categories: string[] }
const load = (key: string): Tool[] => JSON.parse(readFileSync(genPath(key), 'utf8')) as Tool[];

describe('A. codegen conformance / no-drift', () => {
  for (const c of CONNECTORS) {
    describe(c.key, () => {
      it('generated JSON exists and is non-empty', () => {
        expect(statSync(genPath(c.key)).size).toBeGreaterThan(0);
      });

      if (!sourceAvailable(c)) return; // CI: skip the heavy parse/regen for the uncommitted giant specs.

      it('a fresh regen equals the committed JSON byte-for-byte (no drift)', () => {
        expect(emitJson(regen(c))).toBe(readFileSync(genPath(c.key), 'utf8'));
      }, 60_000);

      it('unique names + valid HITL categories', () => {
        const tools = load(c.key);
        expect(tools.length).toBeGreaterThan(0);
        expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
        for (const t of tools) for (const cat of t.categories) expect(VALID_CATEGORIES.has(cat)).toBe(true);
      });

      if (c.openapi || c.wsdlDir) {
        it('every documented operation became exactly one tool', () => {
          expect(regen(c).length).toBe(operationCount(c));
        }, 60_000);
      }

      if (c.key === 'workday_wws') {
        it('read/write categorization is fail-secure (only Get_/Find_/Retrieve_ read)', () => {
          for (const t of load(c.key)) {
            const op = String(t.entityType).split(' ')[2] ?? '';
            expect(t.categories).toEqual([/^(Get|Find|Retrieve)_/.test(op) ? 'read' : 'write']);
          }
        });
      }
    });
  }
});
