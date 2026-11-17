// A server that states what its tool does should be believed about it.
//
// Vendor tool safety was derived from the tool's NAME: a recognised read verb
// meant read, anything unrecognised meant write, and write on an
// untrusted-inbound run raises an approval card. So identical behaviour gates or
// does not purely on the author's choice of word — `search_docs` passes,
// `lookup_article`, `query_docs` and `find_answer` all gate. That is a tax on
// every custom MCP server a user connects, paid in cards nobody can answer.
//
// MCP has published tool annotations since the 2025-03-26 revision, and the SDK
// models them. They were arriving on every tools/list response and being dropped
// at the type boundary, while the code guessed at what they already stated.
//
// The mapping is asymmetric on purpose. The spec is explicit that annotations
// are hints and must not be relied on as a security boundary for an untrusted
// server, so a hint may ADD caution freely and may only REMOVE it with the
// name-based classifier's agreement.

import { effectFromMcpAnnotations } from '../tool-effect';

describe('a hint that adds caution is always honoured', () => {
  it('destructiveHint makes it a write', () => {
    expect(effectFromMcpAnnotations({ destructiveHint: true })).toBe('write');
  });

  it('destructiveHint wins over readOnlyHint', () => {
    // Contradictory annotations resolve to the safer reading.
    expect(effectFromMcpAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('write');
  });

  it('is honoured even for an innocuous-looking name', () => {
    expect(effectFromMcpAnnotations({ destructiveHint: true }, { nameLooksMutating: false })).toBe('write');
  });
});

describe('a hint that removes caution needs the name to agree', () => {
  it('readOnlyHint makes it a read when the name shows no action evidence', () => {
    // This is the whole point: `lookup_article` stops gating because its server
    // says it only reads and its verb is simply unrecognised.
    expect(effectFromMcpAnnotations({ readOnlyHint: true })).toBe('read');
    expect(effectFromMcpAnnotations({ readOnlyHint: true }, { nameLooksMutating: false })).toBe('read');
  });

  it('is REFUSED when the name shows recognized mutation/outbound evidence', () => {
    // A server does not get to declare `delete_everything`, `charge_card` or
    // `publish_post` read-only. Any recognized action name refuses the rescue.
    expect(effectFromMcpAnnotations({ readOnlyHint: true }, { nameLooksMutating: true })).toBeNull();
  });
});

describe('silence changes nothing', () => {
  it.each([
    ['no annotations at all', undefined],
    ['an empty object', {}],
    ['only idempotentHint', { idempotentHint: true }],
    ['only openWorldHint', { openWorldHint: true }],
    ['explicitly false hints', { readOnlyHint: false, destructiveHint: false }],
  ])('%s falls through to the name heuristic', (_label, annotations) => {
    // null means "decide it the way you did before", not "treat it as read".
    expect(effectFromMcpAnnotations(annotations as never)).toBeNull();
  });
});

describe('the enumerator prefers what was declared', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'agent-execution', 'adapter', 'vendor-mcp-enumerate.ts'),
    'utf8',
  ) as string;

  it('reads annotations off the tools/list entry', () => {
    expect(SRC).toContain('annotations?: McpToolAnnotations;');
    expect(SRC).toContain('effectFromMcpAnnotations(t.annotations');
  });

  it('falls back to the name classifier, so nothing regresses on silence', () => {
    expect(SRC).toContain('declared ?? classifyVendorToolEffect(t.name)');
  });

  it('lets destructiveHint add the destructive category and the marker', () => {
    // The level-2 gate and isLowRiskTool read the category and the description
    // marker, so a declared-destructive tool has to reach both.
    expect(SRC).toContain("t.annotations?.destructiveHint === true");
    expect(SRC).toContain("'destructive', 'dataChanges'");
    expect(SRC).toContain('destructive ? `⚠️ DESTRUCTIVE:');
  });
});
