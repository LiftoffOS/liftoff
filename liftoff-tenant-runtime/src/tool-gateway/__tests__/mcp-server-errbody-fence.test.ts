// CI fence (Phase 7 §8.5, TR mirror): every model-facing tool error in the
// tool-gateway MCP server must be produced by the shared buildToolErrorContent
// helper, so the LLM always reads the uniform
// `TOOL_ERROR {error, code, retryable, retry_after_ms?, recovery}` contract.
//
// Static source scan (no project imports) so it runs regardless of whether the
// new proto-gen / connector-types packages are installed. Governance gates
// (snapshot_unavailable, BLOCKED_PRIOR_ATTEMPT, no_handler_registered) are
// intentionally NOT tool errors and keep their bespoke text — they never emit
// the TOOL_ERROR envelope, which is exactly what this fence guarantees.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

describe('mcp-server errBody fence', () => {
  it('the TOOL_ERROR envelope is produced ONLY inside buildToolErrorContent', () => {
    // The envelope is emitted via the template interpolation `TOOL_ERROR ${…}`.
    // Exactly one such interpolation must exist — the one in the shared helper.
    // (Doc-comments that merely mention the shape use a literal brace, not `${`.)
    const occurrences = (SRC.match(/TOOL_ERROR \$\{/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('defines the shared buildToolErrorContent helper', () => {
    expect(SRC).toContain('function buildToolErrorContent');
  });

  it('routes the connector + slack + external-agent + standard-tool error paths through the helper', () => {
    const uses = (SRC.match(/buildToolErrorContent\(/g) ?? []).length;
    // 1 definition + ≥5 call sites (connector non-throw, connector catch,
    // slack catch, external-agent catch, standard-tool failure).
    expect(uses).toBeGreaterThanOrEqual(6);
  });
});
