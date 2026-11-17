// A measurement wrapper has one absolute obligation — never change what it
// measures — and one thing it must get right, which is the difference between a
// result that was parked and one that was cut. These test both.

import { observeAndBoundToolResults, observeDirectMcpResultSize, wasBounded } from '../observe-result-size';
import { withCompleteness } from '../result-completeness';
import { DATASET_DIR } from '../result-dataset';
import { SPILL_DIR, resetTurnUsage } from '../../agent-execution/adapter/tool-result-bound';

const logged: Array<Record<string, unknown>> = [];
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: (p: Record<string, unknown>) => { logged.push(p); } },
}));

const mockPark = jest.fn();
jest.mock('../../clients/platform-backend-client', () => ({
  parkToolResultViaBackend: (...args: unknown[]) => mockPark(...args),
}));

function textTool(name: string, text: string) {
  return {
    name,
    handler: jest.fn(async () => ({ content: [{ type: 'text', text }] })),
  };
}

beforeEach(() => {
  logged.length = 0;
  mockPark.mockReset();
  delete process.env.TOOL_RESULT_MAX_CHARS;
  delete process.env.TOOL_RESULT_BOUND_ENABLED;
  delete process.env.TOOL_RESULT_TURN_BUDGET_CHARS;
});

describe('observing tool result size', () => {
  // The BOUND is on by default now, and it emits a `tool_result_size_observed`
  // line of its own (tool-result-bound.ts#recordObservedSize) for the same
  // result. These assertions are about the WRAPPER's line, which is the one
  // that carries the tool and whether the result was parked, so they are taken
  // from the lines that carry a tool name.
  const wrapperLines = () => logged.filter((l) => l.toolName !== undefined);

  it('hands the result back byte for byte', async () => {
    const original = { content: [{ type: 'text', text: 'hello' }], isError: false, _meta: { a: 1 } };
    const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => original }]);
    const out = await wrapped.handler(undefined as never, undefined as never);
    // Identity, not deep equality: a wrapper that reconstructs the result is a
    // wrapper that can drop a field nobody notices until an engine needs it.
    expect(out).toBe(original);
  });

  it('keeps the tool\'s own name, description and schema', async () => {
    const tool = { name: 'corpus_search', description: 'd', inputSchema: { q: 1 }, handler: async () => ({}) };
    const [wrapped] = observeAndBoundToolResults([tool]);
    expect(wrapped).toMatchObject({ name: 'corpus_search', description: 'd', inputSchema: { q: 1 } });
  });

  it('records the largest text block and the tool that produced it', async () => {
    const [wrapped] = observeAndBoundToolResults([{
      name: 'web_research',
      handler: async () => ({ content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'abcdef' }] }),
    }]);
    await wrapped.handler(undefined as never, undefined as never);
    expect(wrapperLines()).toHaveLength(1);
    expect(wrapperLines()[0]).toMatchObject({ chars: 6, toolName: 'web_research', exceeded: false });
  });

  it('reads the same budget the bound uses, so the two cannot disagree', async () => {
    process.env.TOOL_RESULT_MAX_CHARS = '3';
    const [wrapped] = observeAndBoundToolResults([textTool('t', 'abcdef')]);
    await wrapped.handler(undefined as never, undefined as never);
    expect(logged[0]).toMatchObject({ budget: 3, exceeded: true });
  });

  it('calls an oversized result parked when the result says a copy was kept', async () => {
    // The distinction the whole event exists for, now read off the result
    // rather than recovered from its prose. Both parking mechanisms set the
    // same field, so one assertion covers the dataset and the spill.
    process.env.TOOL_RESULT_MAX_CHARS = '10';
    for (const dir of [DATASET_DIR, SPILL_DIR]) {
      logged.length = 0;
      const parked = withCompleteness(
        // Longer than the budget set above: `exceeded` measures the block that
        // reached context, and the point of the pair is over-budget AND kept.
        { content: [{ type: 'text', text: 'preview of a much larger result' }] },
        { complete: false, full: { path: `${dir}/abc.json`, bytes: 900_000, format: 'json' } },
      );
      const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => parked }]);
      await wrapped.handler(undefined as never, undefined as never);
      expect(logged[0]).toMatchObject({ exceeded: true, parked: true });
    }
  });

  it('does NOT call it parked merely because the text names a directory', async () => {
    // The measurement used to be a substring search over the text, so a result
    // that quoted a filename read as recoverable when nothing had been written.
    // Reporting a copy that does not exist is worse than reporting none: the
    // next decision is whether data was lost.
    process.env.TOOL_RESULT_MAX_CHARS = '10';
    const [wrapped] = observeAndBoundToolResults([
      textTool('t', `preview…[more written to ${DATASET_DIR}/abc.json. Read that file.]`),
    ]);
    await wrapped.handler(undefined as never, undefined as never);
    expect(logged[0]).toMatchObject({ exceeded: true, parked: false });
  });

  it('calls an oversized result NOT parked when the remainder is simply gone', async () => {
    process.env.TOOL_RESULT_MAX_CHARS = '10';
    const [wrapped] = observeAndBoundToolResults([
      textTool('t', 'preview…[truncated: 900000 more chars — narrow your query]'),
    ]);
    await wrapped.handler(undefined as never, undefined as never);
    // exceeded AND not parked is the finding: the agent lost the rest.
    expect(logged[0]).toMatchObject({ exceeded: true, parked: false });
  });

  it('says nothing about a result with no text', async () => {
    // One line per tool call across the fleet, to learn that most results are
    // small, is a cost with no reader.
    const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => ({ content: [] }) }]);
    await wrapped.handler(undefined as never, undefined as never);
    expect(logged).toEqual([]);
  });

  it('lets the tool\'s own error through untouched', async () => {
    // A thrown tool call is the tool's failure, and it must arrive as itself.
    // Measuring it would record the length of an error string as a result size.
    const boom = new Error('vendor 502');
    const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => { throw boom; } }]);
    await expect(wrapped.handler(undefined as never, undefined as never)).rejects.toBe(boom);
    expect(logged).toEqual([]);
  });

  it('cannot fail a tool call by failing to measure', async () => {
    const result = { get content(): never { throw new Error('exploding getter'); } };
    const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => result }]);
    await expect(wrapped.handler(undefined as never, undefined as never)).resolves.toBe(result);
  });

  it('wraps every tool it is given', async () => {
    const tools = [textTool('a', 'xx'), textTool('b', 'yyy')];
    const wrapped = observeAndBoundToolResults(tools);
    for (const w of wrapped) await w.handler(undefined as never, undefined as never);
    expect(wrapperLines().map((l) => l.toolName)).toEqual(['a', 'b']);
  });
});

// ── Bounding, on every engine ────────────────────────────────────────────────
//
// The enforcement used to live only in mcp-bridge, which serves the OpenAI /
// Gemini / Grok / OpenRouter loops. The Anthropic path bypasses that bridge by
// construction, so ~99% of production measured its results and passed every one
// of them through whole. These pin the enforcement HERE, above the engine, where
// it applies to all of them.

describe('bounding tool results', () => {
  // Above the 2,000-char spill preview, as production's 50,000 is. A budget
  // below the preview would truncate the preview itself and take the path note
  // with it -- which is a test artefact, not a behaviour worth pinning.
  const MAX = 5_000;
  const OVERSIZED = 'x'.repeat(6_000);

  beforeEach(() => {
    process.env.TOOL_RESULT_BOUND_ENABLED = '1';
    process.env.TOOL_RESULT_MAX_CHARS = String(MAX);
  });

  it('bounds an oversized result when there is no filesystem to spill to', async () => {
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-1' });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(out.content[0].text.length).toBeLessThan(OVERSIZED.length);
    expect(out.content[0].text).toMatch(/narrow your query or paginate/);
  });

  it('SPILLS rather than truncates when the run has a sandbox, losing nothing', async () => {
    // Same context cost either way; spilling keeps the remainder reachable.
    const writes: Array<{ path: string; content: string }> = [];
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], {
      invocationId: 'inv-2',
      writeFile: async (path, content) => { writes.push({ path, content }); return true; },
    });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(OVERSIZED);          // the whole thing survives
    expect(writes[0].path.startsWith(SPILL_DIR)).toBe(true);
    expect(out.content[0].text).toContain(writes[0].path); // and the model is told where
    expect(out.content[0].text.length).toBeLessThan(OVERSIZED.length);
  });

  it('leaves a result under the budget completely alone', async () => {
    const [wrapped] = observeAndBoundToolResults([textTool('t', 'small')], { invocationId: 'inv-3' });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(out.content[0].text).toBe('small');
  });

  it('never touches an error envelope', async () => {
    // A TOOL_ERROR envelope is small and must reach the model verbatim.
    const errText = 'y'.repeat(1_200);
    const [wrapped] = observeAndBoundToolResults([{
      name: 't',
      handler: async () => ({ content: [{ type: 'text', text: errText }], isError: true }),
    }], { invocationId: 'inv-4' });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(out.content[0].text).toBe(errText);
  });

  it('enforces the AGGREGATE turn budget, which one-result caps cannot', async () => {
    // The run that prompted this breached the per-result cap once and still put
    // ~279,000 characters into the window across 60 calls.
    process.env.TOOL_RESULT_TURN_BUDGET_CHARS = '4000';
    const [wrapped] = observeAndBoundToolResults([textTool('t', 'z'.repeat(3_000))], { invocationId: 'inv-5' });

    const first = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    const second = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(first.content[0].text.length).toBe(3_000);          // under the per-result cap
    expect(second.content[0].text.length).toBeLessThan(3_000); // past the turn budget, bounded hard
    expect(logged.some((l) => l.event === 'tool_result_turn_budget_exceeded')).toBe(true);
  });

  it('a reset between turns restores the whole allowance', async () => {
    // The property the per-step reset buys. Without it the run's LAST step
    // reads quarter-sized results because its FIRST step spent the budget —
    // which is what "read the competitors one at a time" was supposed to stop.
    process.env.TOOL_RESULT_TURN_BUDGET_CHARS = '4000';
    const [wrapped] = observeAndBoundToolResults([textTool('t', 'z'.repeat(3_000))], { invocationId: 'inv-turn' });

    const first = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    const second = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(first.content[0].text.length).toBe(3_000);
    expect(second.content[0].text.length).toBeLessThan(3_000);   // budget spent

    resetTurnUsage('inv-turn');                                   // the next step's turn begins

    const third = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(third.content[0].text.length).toBe(3_000);             // whole allowance again
  });

  it('marks what it handled, so mcp-bridge does not count the same characters twice', async () => {
    // mcp-bridge dispatches in-process tools through client.callTool, which
    // reaches these handlers. Without the marker its own pass would run again
    // and trip the aggregate budget at half its configured size on exactly the
    // engines this change is not meant to alter.
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-6' });
    const out = await wrapped.handler(undefined as never, undefined as never);

    expect(wasBounded(out)).toBe(true);
    expect(wasBounded({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
  });

  it('does nothing at all when the bound is switched OFF', async () => {
    // The variable is the opt-out now, not the opt-in: an UNSET variable
    // leaves the protection on, which is the whole point of the default
    // changing. Only an explicit '0' (or 'false') turns it off.
    process.env.TOOL_RESULT_BOUND_ENABLED = '0';
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-7' });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(out.content[0].text).toBe(OVERSIZED);
    expect(wasBounded(out)).toBe(false);
  });

  it('is ON with the variable unset — the protection is the default, the variable is the opt-out', async () => {
    // It used to be the reverse, and the consequence was that the protection
    // existed only where somebody had remembered to set a variable.
    delete process.env.TOOL_RESULT_BOUND_ENABLED;
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-default' });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(out.content[0].text.length).toBeLessThan(OVERSIZED.length);
    expect(wasBounded(out)).toBe(true);
  });

  it('returns the result whole when the bound itself throws', async () => {
    // A protection meant to make a result manageable must not be able to lose it.
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], {
      invocationId: 'inv-8',
      writeFile: async () => { throw new Error('sandbox gone'); },
    });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    // The spill failed; the bound still applied rather than the call failing.
    expect(out.content[0].text.length).toBeLessThan(OVERSIZED.length);
    expect(out.content[0].text).toMatch(/narrow your query or paginate/);
  });
});

// ── Parking, which keeps the whole result ────────────────────────────────────
//
// Bounding keeps the window safe and throws the remainder away; the part past
// the cut is often exactly the part the run needed, and the bytes are gone.
// Parking is the same protection without the loss. The three fallbacks are
// ordered by how much they keep — park, spill, bound — and the weakest of them
// is what this path did before, so nothing here can make a result worse.

describe('parking an oversized tool result', () => {
  const MAX = 5_000;
  const OVERSIZED = 'x'.repeat(6_000);
  const PARKED_VIEW = '3 records were fetched and kept as dataset abc.';
  const job = { tenantId: 'tenant-1', datasetScopeId: 'thread-9' };

  beforeEach(() => {
    process.env.TOOL_RESULT_BOUND_ENABLED = '1';
    process.env.TOOL_RESULT_MAX_CHARS = String(MAX);
  });

  it('parks under this job, names the tool, and hands the model the view', async () => {
    mockPark.mockResolvedValue({
      ok: true,
      result: { content: [{ type: 'text', text: PARKED_VIEW }] },
      parked: [{ datasetId: 'abc', recordCount: 3 }],
    });
    const [wrapped] = observeAndBoundToolResults([textTool('web_research', OVERSIZED)], { invocationId: 'inv-p1', ...job });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(mockPark).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ content: [{ type: 'text', text: OVERSIZED }] }),
      { scopeId: 'thread-9' },
      { label: 'web_research result', source: 'agent_tool', sourceRef: 'web_research' },
    );
    expect(out.content[0].text).toBe(PARKED_VIEW);
    expect(wasBounded(out)).toBe(true);
    expect(logged).toContainEqual(expect.objectContaining({
      event: 'tool_result_parked', toolName: 'web_research', datasets: 1, records: 3,
    }));
  });

  it('makes no request at all for an ordinary result', async () => {
    const [wrapped] = observeAndBoundToolResults([textTool('t', 'small')], { invocationId: 'inv-p2', ...job });
    await wrapped.handler(undefined as never, undefined as never);
    expect(mockPark).not.toHaveBeenCalled();
  });

  it('makes no request when there is no job to park under', async () => {
    // A run with neither a conversation nor an invocation has nowhere to park
    // to, and a dataset nothing can list is a dataset nobody can read.
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-p3' });
    await wrapped.handler(undefined as never, undefined as never);
    expect(mockPark).not.toHaveBeenCalled();
  });

  it('falls back to the SPILL when the park fails, losing nothing either', async () => {
    mockPark.mockResolvedValue({ ok: false, reason: 'HTTP 503' });
    const written: Array<{ path: string; content: string }> = [];
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], {
      invocationId: 'inv-p4',
      ...job,
      writeFile: async (path: string, content: string) => { written.push({ path, content }); return true; },
    });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };

    expect(written).toHaveLength(1);
    expect(written[0].content).toBe(OVERSIZED);
    expect(out.content[0].text).toMatch(new RegExp(SPILL_DIR));
    expect(logged).toContainEqual(expect.objectContaining({ event: 'tool_result_park_failed', reason: 'HTTP 503' }));
  });

  it('falls back to the BOUND when neither a park nor a spill is available', async () => {
    mockPark.mockResolvedValue({ ok: false, reason: 'timeout' });
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-p5', ...job });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(out.content[0].text.length).toBeLessThan(OVERSIZED.length);
    expect(out.content[0].text).toMatch(/narrow your query or paginate/);
  });

  it('cannot fail a tool call by failing to park', async () => {
    mockPark.mockRejectedValue(new Error('the client threw'));
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-p6', ...job });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(out.content[0].text.length).toBeGreaterThan(0);
  });

  it('leaves a result the connector path already wrote to the WORKSPACE alone', async () => {
    // `result-dataset.ts` parks an oversized connector result as clean JSON in
    // the run's sandbox and hands back a ~2,000-character preview plus the
    // path. That mechanism is what a `requiresComplete` tool's refusal is
    // measured against, and it stays: the preview is under the bound, so
    // nothing here touches it and nothing is parked twice.
    const parked = withCompleteness(
      { content: [{ type: 'text', text: 'preview of a much larger result' }] },
      { complete: false, full: { path: `${DATASET_DIR}/abc.json`, bytes: 900_000, format: 'json' } },
    );
    const [wrapped] = observeAndBoundToolResults([{ name: 't', handler: async () => parked }], { invocationId: 'inv-p9', ...job });
    const out = await wrapped.handler(undefined as never, undefined as never);

    expect(mockPark).not.toHaveBeenCalled();
    expect(out).toBe(parked);
    expect(logged).toContainEqual(expect.objectContaining({ parked: true }));
  });

  it('never parks an ERROR result: it is what the model recovers from', async () => {
    const [wrapped] = observeAndBoundToolResults([{
      name: 't',
      handler: async () => ({ content: [{ type: 'text', text: OVERSIZED }], isError: true }),
    }], { invocationId: 'inv-p7', ...job });
    const out = await wrapped.handler(undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(mockPark).not.toHaveBeenCalled();
    expect(out.content[0].text).toBe(OVERSIZED);
  });

  it('still counts a parked result against the turn budget', async () => {
    // A view is small, but sixty of them are a window.
    process.env.TOOL_RESULT_TURN_BUDGET_CHARS = '10';
    mockPark.mockResolvedValue({
      ok: true,
      result: { content: [{ type: 'text', text: 'a'.repeat(50) }] },
      parked: [{ datasetId: 'abc', recordCount: 1 }],
    });
    const [wrapped] = observeAndBoundToolResults([textTool('t', OVERSIZED)], { invocationId: 'inv-p8', ...job });
    await wrapped.handler(undefined as never, undefined as never);
    expect(logged).toContainEqual(expect.objectContaining({ event: 'tool_result_turn_budget_exceeded' }));
  });
});

// ── Direct MCP: measured, never parked ───────────────────────────────────────

describe('observeDirectMcpResultSize', () => {
  it('records the size of a vendor-hosted result, marked as direct and never parked', () => {
    observeDirectMcpResultSize('mcp__github__list_issues', { content: [{ type: 'text', text: 'y'.repeat(70_000) }] }, 'inv-d1');
    expect(logged).toEqual([expect.objectContaining({
      event: 'tool_result_size_observed',
      chars: 70_000,
      exceeded: true,
      parked: false,
      direct: true,
      toolName: 'mcp__github__list_issues',
      invocationId: 'inv-d1',
    })]);
  });

  it('says nothing about a result with no text', () => {
    observeDirectMcpResultSize('mcp__notion__search', { content: [] }, 'inv-d2');
    expect(logged).toEqual([]);
  });

  it('cannot fail a tool call by failing to measure', () => {
    expect(() => observeDirectMcpResultSize('mcp__x__y', { get content(): never { throw new Error('boom'); } }, undefined)).not.toThrow();
  });
});
