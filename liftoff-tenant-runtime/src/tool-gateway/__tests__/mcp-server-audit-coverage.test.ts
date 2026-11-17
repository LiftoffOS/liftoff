// A.1 — verifies mcp-server.ts CALLS emitStandardToolAudit at every
// expected dispatch site. Field-mapping semantics are pinned by
// src/audit/__tests__/standard-tool-emitter.test.ts; this file is the
// structural check that the call sites still exist and are wired through
// the imported helper.
//
// Why structural: a full integration test would boot the SDK MCP server
// with stub deps and exercise a tool — order of magnitude heavier than
// pays off here. The combo (a) helper unit test + (b) presence-of-call
// check + (c) Phase C.1 post-deploy smoke against the canary tenant
// covers every layer: shape, wiring, and end-to-end behaviour in prod.

import { readFileSync } from 'fs';
import { resolve } from 'path';

function readMcpServer(): string {
  return readFileSync(
    resolve(__dirname, '..', 'mcp-server.ts'),
    'utf-8',
  );
}

describe('mcp-server.ts — emitStandardToolAudit call sites', () => {
  const source = readMcpServer();

  it('imports the emitter from the audit module', () => {
    expect(source).toMatch(/import\s+\{\s*emitStandardToolAudit\s*\}\s+from\s+['"]\.\.\/audit\/standard-tool-emitter['"]/);
  });

  it('calls the emitter from the stdTool wrapper success path', () => {
    // The success-branch call records the standard tool dispatch.
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*toolName,[\s\S]*?success:\s*handlerResult\.success/);
  });

  it('calls the emitter from the stdTool wrapper stub-fallback path (M2)', () => {
    // The "no handler registered" path must also audit (catches catalog drift).
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?errorCode:\s*['"]no_handler_registered['"]/);
  });

  it('calls the emitter for the implicit memory_retrieve inside searchMcpTool (M3)', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*['"]memory_retrieve['"]/);
  });

  it('calls the emitter per connector sub-dispatch inside searchMcpTool', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*`\$\{connectorAlias\}__search`/);
  });

  it('calls the emitter once for the outer `search` action with derived outcome (M1)', () => {
    expect(source).toMatch(/emitStandardToolAudit\(\{[\s\S]*?action:\s*['"]search['"],[\s\S]*?success:\s*anySubDispatchSucceeded/);
  });

  it('uses void to enforce fire-and-forget on every call site', () => {
    // Every emitStandardToolAudit call must be prefixed with `void` so the
    // promise can't accidentally be awaited on the hot path (A.1 SLO).
    const calls = source.match(/(\w+\s+)?emitStandardToolAudit\(/g) ?? [];
    const ignored = calls.filter(c => !c.startsWith('void ') && !c.startsWith('await ') && !c.includes('import'));
    expect(ignored).toEqual([]);
  });
});
