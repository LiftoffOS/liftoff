// Self-wake pause-marker detection across vendor tool-result shapes. The wake tool returns
// {__wakePending:{spec,...}} as its result; each adapter must detect it regardless of how the vendor
// SDK hands the result back, or the run is never suspended (the model just gets the marker as a normal
// tool result and fabricates a "resumed" reply — the exact bug the dev E2E caught for the Claude Agent
// SDK, whose PostToolUse hook delivers tool_response AS the block array, not {content:[...]}).
//
// The mcp-bridge (openai/gemini/codex/opencode) path is exercised here via its exported
// extractWakePending. The anthropic path uses the same flatten-both-shapes logic inline.

import { extractWakePending } from '../mcp-bridge';

const spec = { kind: 'timer' as const, firesAt: '2026-07-30T05:00:00.000Z', note: 'e2e' };
const markerText = JSON.stringify({ __wakePending: { spec, originTrust: 'trusted', wakeChainDepth: 0 } });

describe('extractWakePending — vendor tool-result shape robustness', () => {
  it('detects the marker when the result is the block array itself (Claude Agent SDK hook shape)', () => {
    const w = extractWakePending([{ type: 'text', text: markerText }]);
    expect(w).not.toBeNull();
    expect(w!.spec.kind).toBe('timer');
    expect((w!.spec as { firesAt: string }).firesAt).toBe(spec.firesAt);
    expect(w!.originTrust).toBe('trusted');
  });

  it('detects the marker when wrapped as {content:[...]} (MCP client callTool shape)', () => {
    const w = extractWakePending({ content: [{ type: 'text', text: markerText }], isError: false });
    expect(w).not.toBeNull();
    expect(w!.spec.kind).toBe('timer');
  });

  it('detects the marker from a bare string result', () => {
    const w = extractWakePending(markerText);
    expect(w).not.toBeNull();
    expect(w!.spec.kind).toBe('timer');
  });

  it('returns null for a normal (non-marker) tool result', () => {
    expect(extractWakePending([{ type: 'text', text: JSON.stringify({ ok: true, rows: 3 }) }])).toBeNull();
    expect(extractWakePending({ content: [{ type: 'text', text: 'done' }] })).toBeNull();
    expect(extractWakePending('just some text')).toBeNull();
  });

  it('returns null for a malformed / spec-less marker (never a bogus pause)', () => {
    expect(extractWakePending([{ type: 'text', text: '{"__wakePending":' }])).toBeNull();       // truncated
    expect(extractWakePending([{ type: 'text', text: '{"__wakePending":{}}' }])).toBeNull();     // no spec
    expect(extractWakePending(null)).toBeNull();
    expect(extractWakePending(undefined)).toBeNull();
  });

  it('detects a poll-kind marker (non-timer spec) too', () => {
    const pollText = JSON.stringify({ __wakePending: { spec: { kind: 'poll', checkTool: 't', checkArgs: {}, until: { op: 'eq', path: 'x', value: 1 }, intervalSeconds: 60, maxAttempts: 3, note: '' }, originTrust: 'untrusted_inbound', wakeChainDepth: 0 } });
    const w = extractWakePending([{ type: 'text', text: pollText }]);
    expect(w).not.toBeNull();
    expect(w!.spec.kind).toBe('poll');
    expect(w!.originTrust).toBe('untrusted_inbound');
  });
});
