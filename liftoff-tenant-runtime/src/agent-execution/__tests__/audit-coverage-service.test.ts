// A.1 — verifies service.ts CALLS emitStandardToolAudit at every expected
// autonomous-path dispatch site. See sibling tool-gateway/__tests__/
// mcp-server-audit-coverage.test.ts for the interactive-path equivalent.
//
// Field-mapping semantics are pinned by audit/__tests__/standard-tool-emitter.test.ts.

import { readFileSync } from 'fs';
import { resolve } from 'path';

function readService(): string {
  return readFileSync(
    resolve(__dirname, '..', 'service.ts'),
    'utf-8',
  );
}

describe('service.ts — emitStandardToolAudit call sites', () => {
  const source = readService();

  it('imports the emitter from the audit module', () => {
    expect(source).toMatch(/import\s+\{\s*emitStandardToolAudit\s*\}\s+from\s+['"]\.\.\/audit\/standard-tool-emitter['"]/);
  });

  it('calls the emitter from the standard-tool branch in executeTask', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*toolCall\.actionType,[\s\S]*?success:\s*stdResult\.success/);
  });

  it('calls the emitter for memory_retrieve inside executeSearchBuiltin (S2/M3)', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*['"]memory_retrieve['"]/);
  });

  it('calls the emitter per connector sub-dispatch in executeSearchBuiltin', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*`\$\{connectorAlias\}__search`/);
  });

  it('calls the emitter once for the outer `search` action with derived outcome (S1/M1)', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*['"]search['"],[\s\S]*?success:\s*anySubDispatchSucceeded/);
  });

  it('uses void to enforce fire-and-forget on every emitStandardToolAudit call', () => {
    const calls = source.match(/(\w+\s+)?emitStandardToolAudit\(/g) ?? [];
    const ignored = calls.filter(c => !c.startsWith('void ') && !c.startsWith('await ') && !c.includes('import'));
    expect(ignored).toEqual([]);
  });
});
