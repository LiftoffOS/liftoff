// Response-shape contract gate for native HRIS fixtures.
//
// Every native-HRIS fixture must conform to its tool's codegen responseSchema (extra/undocumented
// fields allowed; documented fields type-checked — same lenient rule the runtime drift checker
// uses). This is what keeps a doc-sourced or captured fixture honest without a live tenant to
// re-capture from — the replacement for the 120-day age gate (doc-sourced connectors are exempt
// from that; see fixture-age-test.test.ts + __lib__/doc-sourced.ts).
//
// Forward-looking: Phase 4 captures fixtures keyed by the tool `name`, so captured fixtures map to
// a tool with a responseSchema and are validated here. A fixture whose action does NOT map to a
// codegen'd tool (e.g. a legacy hand-named fixture) is skipped here and covered by the structural
// checks in load-fixtures' assertFixtureShape.
import { loadAllFixtures } from './__lib__/load-fixtures';
import { loadGenerated } from '../../catalog/__tests__/support/regen';
import { validateResponse } from '../../observability/response-conformance';
import { isNativeHrisVerifyType } from '../../catalog/native-hris-types';

// connectorType -> generated tool-set key(s). Most map 1:1; workday is split across modules.
const KEYS: Record<string, string[]> = {
  workday: ['workday_person', 'workday_staffing', 'workday_performance'],
};

function responseSchemaFor(connectorType: string, action: string): unknown {
  for (const k of KEYS[connectorType] ?? [connectorType]) {
    let tools: Array<{ name: string; responseSchema?: unknown }>;
    try {
      tools = loadGenerated(k) as unknown as Array<{ name: string; responseSchema?: unknown }>;
    } catch {
      continue; // no generated set for this key (e.g. a native client with no committed spec)
    }
    const tool = tools.find((t) => t.name === action);
    if (tool?.responseSchema) return tool.responseSchema;
  }
  return undefined;
}

const nativeFx = loadAllFixtures().filter((f) => isNativeHrisVerifyType(f.connectorType));

describe('native HRIS fixtures conform to their tool responseSchema', () => {
  if (nativeFx.length === 0) {
    it('no native HRIS fixtures yet (seeded from docs / captured via Phase 4)', () => {
      expect(true).toBe(true);
    });
  } else {
    it.each(nativeFx.map((f) => [`${f.connectorType}/${f.action}`, f] as const))('%s', (_label, f) => {
      const schema = responseSchemaFor(f.connectorType, f.action);
      if (!schema) return; // action doesn't map to a codegen tool — shape-checked in load-fixtures
      expect(validateResponse(schema, f.body)).toEqual([]);
    });
  }
});
