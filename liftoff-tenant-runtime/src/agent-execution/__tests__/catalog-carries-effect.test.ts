// The catalog must carry `effect`, or every platform tool reads as unknown.
//
// The two halves of the catalog state a tool's nature in DIFFERENT fields.
// Connector tools populate `categories` and leave `effect` unset. Platform tools
// do the reverse: `record_step_output` and `search` are both
// `{ categories: [], effect: 'read' }`.
//
// The map from the gateway's modelTools into McpToolDefinition forwarded
// `categories` and `draftVariant` and dropped `effect`. So platform tools
// arrived at the HITL gate as `{ categories: [], effect: undefined }` — no read
// signal, no write signal, i.e. unknown. Unknown fails closed, which is right
// for a tool nobody classified and wrong for one classified in the field that
// was not copied. `effect`'s own doc comment says platform tools carry a
// concrete value and a missing one gates.
//
// The symptom is a run that pauses for approval on:
//   `record_step_output` — writing a step's result down for the next step to
//                          read
//   `search`             — looking through the agent's own indexed context and
//                          memory
// Neither leaves the process. Both are declared `effect: 'read'` at their push
// site in mcp-server.ts. The classification is correct at both ends and must
// not be lost in between.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const TYPES = readFileSync(join(__dirname, '..', 'adapter', 'catalog-types.ts'), 'utf8');

const mapping = SRC.slice(
  SRC.indexOf('const inProcessTools: import(\'./adapter\').McpToolDefinition[] ='),
  SRC.indexOf('const { enumerateAndMergeVendorMcpTools }'),
);

describe('the gateway → catalog map', () => {
  it('has a block to assert against', () => {
    expect(mapping.length).toBeGreaterThan(400);
  });

  it('forwards effect', () => {
    expect(mapping).toMatch(/effect: \(t as \{ effect\?: 'read' \| 'write' \| 'spawn' \}\)\.effect,/);
  });

  it('still forwards the fields it already carried', () => {
    // The fix must not be a swap. Connector tools depend on `categories`, and
    // the Communication policy depends on `draftVariant`.
    expect(mapping).toContain('categories: (t as { categories?: string[] }).categories,');
    expect(mapping).toContain('draftVariant: (t as { draftVariant?: string }).draftVariant,');
  });

  it('records why the field is not redundant with categories', () => {
    // Without this, `effect` looks like a duplicate of `categories` and is a
    // natural thing for a later cleanup to delete again.
    expect(mapping).toMatch(/connector tools populate `categories` and leave `effect` unset/i);
    expect(mapping).toMatch(/record_step_output/);
    expect(mapping).toMatch(/unknown fails closed|Unknown fails closed/);
  });
});

describe('the destination field still means what the map assumes', () => {
  it('exists on McpToolDefinition and gates when missing', () => {
    expect(TYPES).toContain("effect?: 'read' | 'write' | 'spawn';");
    expect(TYPES).toMatch(/A missing value gates \(fail closed\)/);
  });
});
