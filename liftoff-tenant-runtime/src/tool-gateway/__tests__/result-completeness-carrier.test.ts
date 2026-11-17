// Whether a result is all of the result travels as structure, and is enforced.
//
// Both parking mechanisms used to state this only in English, inside the text
// they handed back. Everything downstream then re-derived it from prose:
// observe-result-size searched for a directory name, and the model had to notice
// a sentence in the middle of a blob it was already too full to read.
//
// The CrowdFunder run is what that costs. The step that reads the existing keys got
// a preview of them, every unseen row looked new, and 17 duplicate campaigns
// were appended to a sheet the agent believed it was deduplicating. The run
// reported success, because from inside a preview there is nothing to notice.
//
// Two things are asserted here, and they are different:
//   P1 — the fact is CARRIED, so a consumer can read it instead of guessing.
//   P2 — for a tool declared as needing the whole result, an incomplete one is
//        REFUSED rather than returned as a success.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { datasetOrInlineWithCompleteness, DATASET_DIR } from '../result-dataset';
import { COMPLETENESS_META_KEY, readCompleteness, withCompleteness } from '../result-completeness';
import { observeAndBoundToolResults } from '../observe-result-size';

const IDS = { tenantId: 't-1', agentId: 'a-1' };

/** Over the 50,000 calibrated bound once serialized. */
function bigJson(): string {
  return JSON.stringify({
    valueRanges: [
      {
        range: 'Sheet1!B:B',
        values: Array.from({ length: 1_600 }, (_, i) => [`https://example.com/campaign-${i}`]),
      },
    ],
  });
}

function acceptingWriter() {
  const written: Array<{ path: string; content: string }> = [];
  const writer = jest.fn(async (path: string, content: string) => {
    written.push({ path, content });
    return true;
  });
  return { written, writer };
}

// ── P1: the fact is carried ──────────────────────────────────────────────────

describe('parking reports completeness as a field, not as prose', () => {
  it('a result inside the bound is complete and has no parked copy', async () => {
    const small = JSON.stringify({ ok: true, rows: 3 });
    const out = await datasetOrInlineWithCompleteness('batch_get_values', small, null, IDS);

    expect(out.complete).toBe(true);
    expect(out.full).toBeUndefined();
    expect(out.text).toBe(small);
  });

  it('a parked result is incomplete and names where the whole of it lives', async () => {
    const { writer } = acceptingWriter();
    const serialized = bigJson();

    const out = await datasetOrInlineWithCompleteness('batch_get_values', serialized, writer, IDS);

    expect(out.complete).toBe(false);
    expect(out.full?.path.startsWith(`${DATASET_DIR}/`)).toBe(true);
    expect(out.full?.bytes).toBe(serialized.length);
    // The format is stated, because the failure this module exists to fix is
    // a parked file whose format nobody has named.
    expect(out.full?.format).toBe('json');
  });

  it('an oversized result with nowhere to park is incomplete AND has no copy', async () => {
    // The worse of the two states, and the one a `parked: true` guess would
    // have hidden: the text is whole here, but a bound further down cuts it and
    // the remainder is gone. Distinguishable only because `full` is absent.
    const out = await datasetOrInlineWithCompleteness('t', bigJson(), null, IDS);

    expect(out.complete).toBe(false);
    expect(out.full).toBeUndefined();
  });

  it('a refused or thrown write is incomplete with no copy', async () => {
    const refusing = jest.fn(async () => false);
    const throwing = jest.fn(async () => { throw new Error('sandbox gone'); });

    for (const w of [refusing, throwing]) {
      const out = await datasetOrInlineWithCompleteness('t', bigJson(), w, IDS);
      expect({ complete: out.complete, full: out.full }).toEqual({ complete: false, full: undefined });
    }
  });
});

describe('the carrier on the result itself', () => {
  it('attaches under a namespaced _meta key and preserves what was there', () => {
    const result = { content: [{ type: 'text', text: 'x' }], _meta: { 'vendor/thing': 1 } };
    const out = withCompleteness(result, { complete: false, full: { path: 'p', bytes: 9, format: 'json' } });

    expect((out._meta as Record<string, unknown>)['vendor/thing']).toBe(1);
    expect((out._meta as Record<string, unknown>)[COMPLETENESS_META_KEY]).toEqual({
      complete: false,
      full: { path: 'p', bytes: 9, format: 'json' },
    });
  });

  it('adds nothing when there is nothing to say', () => {
    // Writing `complete: true` on every result would make an unmeasured result
    // indistinguishable from a verified one — the ambiguity this replaces.
    const result = { content: [{ type: 'text', text: 'x' }] };
    expect(withCompleteness(result, { complete: true })).toBe(result);
  });

  it('an unmeasured result reads as undefined, never as complete', () => {
    // The safe direction, and the reason the reader returns undefined rather
    // than a default: a consumer must never be handed "nobody looked" in a
    // shape it can mistake for "all of it".
    expect(readCompleteness({ content: [] })).toBeUndefined();
    expect(readCompleteness(null)).toBeUndefined();
    expect(readCompleteness({ _meta: {} })).toBeUndefined();
    // A malformed value is unmeasured too, not coerced into a boolean.
    expect(readCompleteness({ _meta: { [COMPLETENESS_META_KEY]: { complete: 'yes' } } })).toBeUndefined();
  });

  it('round-trips through the reader', () => {
    const marked = withCompleteness({ content: [] }, { complete: true, full: { path: 'p', bytes: 1, format: 'json' } });
    expect(readCompleteness(marked)?.complete).toBe(true);
    expect(readCompleteness(marked)?.full?.path).toBe('p');
  });
});

describe('size observation reads the field instead of searching the text', () => {
  const { scrubLogger } = jest.requireMock('../../observability/scrub-logger');

  async function observedEvent(result: unknown): Promise<Record<string, unknown> | undefined> {
    (scrubLogger.info as jest.Mock).mockClear();
    const tools = [{ name: 'read_rows', handler: async () => result }] as never;
    await observeAndBoundToolResults(tools)[0].handler(undefined as never, undefined as never);
    return (scrubLogger.info as jest.Mock).mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((a) => a?.event === 'tool_result_size_observed');
  }

  it('reports parked for a result carrying a copy', async () => {
    const event = await observedEvent(withCompleteness(
      { content: [{ type: 'text', text: 'a preview' }] },
      { complete: false, full: { path: `${DATASET_DIR}/x.json`, bytes: 60_000, format: 'json' } },
    ));
    expect(event?.parked).toBe(true);
  });

  it('does NOT report parked for a result that merely mentions the directory', async () => {
    // The old scan matched the path anywhere in the text, so a result quoting a
    // filename read as recoverable when nothing had been written. A measurement
    // derived from a substring search is not a measurement.
    const event = await observedEvent({
      content: [{ type: 'text', text: `see ${DATASET_DIR}/somebody-elses-file.json for details` }],
    });
    expect(event?.parked).toBe(false);
  });

  it('reports parked false when the result was over budget with nowhere to go', async () => {
    // Over budget AND not parked is the state that means data was lost. It has
    // to be distinguishable from over budget and recoverable.
    const event = await observedEvent(withCompleteness(
      { content: [{ type: 'text', text: 'x'.repeat(60_000) }] },
      { complete: false },
    ));
    expect(event?.parked).toBe(false);
    expect(event?.exceeded).toBe(true);
  });
});

// ── P2: declared tools are refused rather than served a view ─────────────────

describe('the gateway refuses an incomplete result for a declared tool', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'mcp-server.ts'), 'utf8',
  ) as string;

  it('accepts the policy as an input on the gateway', () => {
    expect(SRC).toContain('completeResultRequiredTools?: readonly string[]');
    expect(SRC).toMatch(/const completeRequired = new Set\(completeResultRequiredTools \?\? \[\]\);/);
  });

  it('matches the name the MODEL sees, not the manifest function name', () => {
    // The rule is authored against `<alias>__<function>` — the name in the
    // agent's catalog. `fn.name` is the function inside the manifest
    // (`batch_get_values`). Matching that one is a Set lookup that never hits:
    // no error, no log, a rule that silently protects nothing.
    //
    // Get it wrong and the read parks (`parked: true` on tool_result.chars for
    // google-sheets-2b820bc9__batch_get_values) while no refusal fires, because
    // the Set holds the aliased name and the check is handed the bare one.
    expect(SRC).not.toMatch(/requiresCompleteResult\(fn\.name\)/);
    const checks = SRC.match(/requiresCompleteResult\(toolName\)/g) ?? [];
    expect(checks).toHaveLength(2);
    // And the refusal + log report the same name the model used.
    expect(SRC).not.toMatch(/logCompletenessRefusal\(fn\.name,/);
    expect(SRC).not.toMatch(/incompleteResultError\(fn\.name,/);
  });

  it('checks it on BOTH connector dispatch branches', () => {
    // Two branches reach a connector — composio and native. A guard on one is a
    // policy that holds for some tools and not others, with nothing to say which.
    const guards = SRC.match(/if \(![a-zA-Z]+\.complete && requiresCompleteResult\(toolName\)\) \{/g) ?? [];
    expect(guards).toHaveLength(2);
    const refusals = SRC.match(/return incompleteResultError\(toolName, [a-zA-Z]+\.full\);/g) ?? [];
    expect(refusals).toHaveLength(2);
  });

  it('marks both success returns with the completeness they measured', () => {
    const marked = SRC.match(/return withCompleteness\(\{/g) ?? [];
    expect(marked).toHaveLength(2);
  });

  it('refuses as a retryable error, not a success with a caveat', () => {
    // The caveat is exactly what failed the first time. The refusal has to be
    // the tool's OUTCOME, or the model is free to read past it again.
    const fn = /function incompleteResultError\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
    expect(fn).toContain('retryable: true');
    expect(fn).toContain("code: 'internal_error'");
  });

  it('points the recovery at the workspace copy rather than back into context', () => {
    // Re-requesting the whole result would trade a wrong answer for an
    // overflowed run. The recovery is to reduce the data where it already sits.
    const fn = /function incompleteResultError\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
    expect(fn).toContain('file_read');
    expect(fn).toMatch(/Do not try to bring the whole result into this conversation/);
    // And the branch where nothing was parked must not name a path that does
    // not exist — that is the dead-path failure in a new place.
    expect(fn).toMatch(/no saved copy/);
    expect(fn).toMatch(/Narrow the request/);
  });

  it('logs the refusal with the parked path, so an operator can see it happen', () => {
    expect(SRC).toContain("metric: 'tool_result.incomplete_refused'");
  });

  it('records that it was ARMED, not only that it refused', () => {
    // A policy that never fires and a policy that never arrived both look like
    // silence. Separating them is the difference between "the rule is wrong"
    // and "the rule is missing" — different bugs, different fixes, and a
    // wasted diagnostic pass without this line.
    expect(SRC).toContain("metric: 'tool_result.complete_required_armed'");
    expect(SRC).toMatch(/if \(completeRequired\.size > 0\) \{/);
  });
});
