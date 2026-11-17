// Nested code_session spend must reach the invocation's billed cost.
//
// Before this, a coding session — often the single most expensive thing an
// agent does — ran in its own subprocess against the vendor API and appeared in
// no cost figure at all. These tests pin the two things that make the fix real:
// the session is FOUND (including on the engine where the tool name is lost),
// and what cannot be priced is reported as unpriced rather than as free.

import { computeCodeSessionCost } from '../code-session-cost';

const codeSessionOutput = (over: Record<string, unknown> = {}) => ({
  provider_used: 'anthropic',
  diff: '',
  summary: '',
  tool_calls_made: [],
  files_modified: [],
  exit_reason: 'success',
  ...over,
});

describe('computeCodeSessionCost', () => {
  it('is zero when there are no tool calls at all', () => {
    expect(computeCodeSessionCost(undefined)).toEqual({ costUsd: 0, unpricedByProvider: {} });
    expect(computeCodeSessionCost([])).toEqual({ costUsd: 0, unpricedByProvider: {} });
  });

  it('ignores tool calls that are not coding sessions', () => {
    const calls = [
      { name: 'send_email', output: { success: true, cost_usd: 999 } },
      { name: 'search', output: { results: [] } },
    ];
    expect(computeCodeSessionCost(calls).costUsd).toBe(0);
  });

  it('sums the vendor-reported cost across sessions', () => {
    const calls = [
      { name: 'code_session', output: codeSessionOutput({ cost_usd: 0.42 }) },
      { name: 'code_session', output: codeSessionOutput({ cost_usd: 1.08 }) },
    ];
    expect(computeCodeSessionCost(calls).costUsd).toBeCloseTo(1.5, 10);
  });

  it('finds a session whose tool name was lost', () => {
    // The Claude Agent SDK path is the one that matters: its
    // tool_call_started→finished correlation does not match a callId, so
    // completed calls land as name='unknown' and the real name is only
    // recovered when the trajectory recorder is active. Keying on the name
    // alone would skip that engine entirely.
    const calls = [{ name: 'unknown', output: codeSessionOutput({ cost_usd: 2 }) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(2);
  });

  it('reads an output that arrived as a JSON string', () => {
    const calls = [{ name: 'code_session', output: JSON.stringify(codeSessionOutput({ cost_usd: 0.25 })) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(0.25);
  });

  it('reads the shape the Claude Agent SDK path actually stores', () => {
    // The real layering on the dominant engine, and the one that decides
    // whether any of this works: completedToolCalls stores
    // JSON.stringify(tool_use_result), and tool_use_result for an MCP tool is
    // the envelope {content:[{type:'text',text:'<the real JSON>'}]}. Reading
    // only the outer layer finds no cost_usd, contributes zero, and reports
    // success — nested spend stays invisible with the tests green.
    const envelope = {
      content: [{ type: 'text', text: JSON.stringify(codeSessionOutput({ cost_usd: 3.75 })) }],
      isError: false,
    };
    const calls = [{ name: 'code_session', output: JSON.stringify(envelope) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(3.75);
  });

  it('reads the bare content-block array the SDK path stores', () => {
    // The Claude Agent SDK path stores a JSON string of the BARE content-block
    // array, not the wrapped {content:[...]} the SDK docs describe, and the
    // tool name arrives MCP-qualified. A parser that handles only the wrapped
    // form and the bare name finds nothing, adds nothing, and logs nothing — a
    // session's own cost is dropped and only the outer figure billed, with the
    // whole unit suite green. This test pins that stored shape.
    const blocks = [{ type: 'text', text: JSON.stringify(codeSessionOutput({ cost_usd: 0.356099 })) }];
    const calls = [{
      name: 'mcp__liftoff-tool-gateway__code_session',
      output: JSON.stringify(blocks),
    }];
    expect(computeCodeSessionCost(calls).costUsd).toBeCloseTo(0.356099, 10);
  });

  it('matches the MCP-qualified tool name', () => {
    const calls = [{ name: 'mcp__liftoff-tool-gateway__code_session', output: codeSessionOutput({ cost_usd: 1 }) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(1);
  });

  it('ignores a bare block array that is not a coding session', () => {
    const blocks = [{ type: 'text', text: JSON.stringify({ success: true, recorded: 'complete' }) }];
    const calls = [{ name: 'mcp__liftoff-tool-gateway__report_task_outcome', output: JSON.stringify(blocks) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(0);
  });

  it('reads an unstringified MCP envelope too', () => {
    const calls = [{
      name: 'code_session',
      output: {
        content: [{ type: 'text', text: JSON.stringify(codeSessionOutput({ cost_usd: 1.5 })) }],
        isError: false,
      },
    }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(1.5);
  });

  it('finds an enveloped session even when the tool name was lost', () => {
    // Both hazards at once — the SDK path loses the name AND wraps the output.
    const envelope = {
      content: [{ type: 'text', text: JSON.stringify(codeSessionOutput({ cost_usd: 0.9 })) }],
    };
    const calls = [{ name: 'unknown', output: JSON.stringify(envelope) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(0.9);
  });

  it('does not mistake another tool\'s enveloped output for a session', () => {
    const envelope = { content: [{ type: 'text', text: JSON.stringify({ success: true, cost_usd: 42 }) }] };
    const calls = [{ name: 'send_email', output: JSON.stringify(envelope) }];
    expect(computeCodeSessionCost(calls).costUsd).toBe(0);
  });

  it('reports unpriceable tokens separately instead of pricing them', () => {
    // Codex and the Gemini CLI report tokens while naming no model, so nothing
    // here can look up a rate. They must not silently contribute 0 to the bill
    // with no trace — the caller counts these through the unpriced-token meter.
    const calls = [{
      name: 'code_session',
      output: codeSessionOutput({ provider_used: 'openai', unpriced_tokens: { input: 1200, output: 340 } }),
    }];
    expect(computeCodeSessionCost(calls)).toEqual({
      costUsd: 0,
      unpricedByProvider: { openai: { input: 1200, output: 340 } },
    });
  });

  it('accumulates priced and unpriced spend from a mixed run', () => {
    const calls = [
      { name: 'code_session', output: codeSessionOutput({ cost_usd: 0.5 }) },
      { name: 'code_session', output: codeSessionOutput({ provider_used: 'openai', unpriced_tokens: { input: 10, output: 20 } }) },
      { name: 'code_session', output: codeSessionOutput({ cost_usd: 0.25, unpriced_tokens: { input: 5, output: 1 } }) },
    ];
    expect(computeCodeSessionCost(calls)).toEqual({
      costUsd: 0.75,
      unpricedByProvider: {
        openai: { input: 10, output: 20 },
        anthropic: { input: 5, output: 1 },
      },
    });
  });

  it('treats a session that reported nothing as zero, not NaN', () => {
    // An errored session can return before any usage arrives. Zero is correct;
    // NaN would propagate into the published costUsd and poison the event.
    const calls = [
      { name: 'code_session', output: codeSessionOutput() },
      { name: 'code_session', output: codeSessionOutput({ cost_usd: 'not-a-number' }) },
      { name: 'code_session', output: 'unparseable' },
      { name: 'code_session', output: null },
    ];
    const result = computeCodeSessionCost(calls);
    expect(result.costUsd).toBe(0);
    expect(Number.isNaN(result.costUsd)).toBe(false);
    expect(result.unpricedByProvider).toEqual({});
  });
});
