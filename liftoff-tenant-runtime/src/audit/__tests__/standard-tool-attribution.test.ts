// A standard tool records its thread and what came back, like every other tool.
//
// Sandbox writes, memory reads and searches are the majority of what an agent
// does, and they were audited blind: the emitter ACCEPTED a threadId that no
// caller in the MCP gateway passed, and on success it deliberately recorded no
// result at all.
//
// What each path recorded once the connector paths were fixed, before this:
//   google-docs__get_document   thread ✓  result ✓
//   sandbox:file_write          thread ✗  result ✗
//   sandbox:code_execute        thread ✗  result ✗
// Same defect, third audit family — a green row that says a call happened and
// nothing about what it returned cannot be checked against anything.

import { readFileSync } from 'fs';
import { join } from 'path';
import { summariseToolResult } from '../result-identity';

const emitter = readFileSync(join(__dirname, '..', 'standard-tool-emitter.ts'), 'utf8');
const gateway = readFileSync(
  join(__dirname, '..', '..', 'tool-gateway', 'mcp-server.ts'), 'utf8',
);

/** Each emitStandardToolAudit call's property block. */
function auditCalls(source: string): string[] {
  const calls: string[] = [];
  for (const m of source.matchAll(/emitStandardToolAudit\(\{/g)) {
    calls.push(source.slice(m.index!, source.indexOf('});', m.index!)));
  }
  return calls;
}

describe('what a standard-tool audit row carries', () => {
  // Asserted on BEHAVIOUR through the shared summariser rather than on strings
  // in this file. The first version of these tests read the emitter's source,
  // and broke the moment the summarising moved into its own module — which is
  // the wrong kind of failure: nothing about the audit row had changed.
  it('records the result on SUCCESS, not only on failure', () => {
    expect(emitter).toMatch(/input\.success\s*\n?\s*\? summariseToolResult\(input\.result\)/);
  });

  it('bounds the summary', () => {
    expect(summariseToolResult({ note: 'x'.repeat(900) })!.length).toBeLessThanOrEqual(500);
  });

  it('tells "returns nothing" apart from "nobody wrote it down"', () => {
    // undefined in, undefined out — an absent summary then means the tool has
    // no result, rather than that the row was written blind.
    expect(summariseToolResult(undefined)).toBeUndefined();
  });

  it('still records something when a result cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summariseToolResult(circular)).toBe('[unserialisable result]');
  });
});

describe('every caller names the conversation', () => {
  it('passes threadId at every gateway site', () => {
    const calls = auditCalls(gateway);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      expect(call).toMatch(/(^|\s)threadId,/);
    }
  });

  it('passes the result where the dispatch has one', () => {
    const handler = auditCalls(gateway).find(c => c.includes('handlerResult.success'));
    expect(handler).toBeDefined();
    expect(handler!).toContain('result: handlerResult.result');
  });
});
