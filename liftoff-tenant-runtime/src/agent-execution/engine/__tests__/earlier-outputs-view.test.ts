// Every earlier output gets the predecessor's contract; selected first,
// materialised second, under a hard ceiling on the rendered text.

const mockCompress = jest.fn();
jest.mock('../compress-for-prompt', () => ({
  compressForPrompt: (...a: unknown[]) => mockCompress(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  FRAME_RESERVE,
  planEarlierOutputs,
  prepareView,
  renderEarlierOutputs,
  stubFor,
  type EarlierEntry,
  type PreparedView,
} from '../earlier-outputs-view';
import { STEP_OUTPUT_BUDGET, EARLIER_OUTPUTS_BUDGET } from '../prompt-budgets';
import { offloadNote } from '../offload-large-value';
import { serializeForPrompt } from '../truncate-for-prompt';
import { stepsReferencedBy } from '../../step-output-keys';

const VALUE_BUDGET = STEP_OUTPUT_BUDGET;
const CEILING = EARLIER_OUTPUTS_BUDGET;

function entry(
  stepId: string,
  value: unknown,
  over: Partial<Omit<EarlierEntry, 'stepId' | 'chars'>> = {},
): EarlierEntry {
  return {
    stepId,
    chars: serializeForPrompt(value).length,
    mustBeWhole: false,
    failed: false,
    ...over,
  };
}

/** A string whose JSON serialisation is exactly `chars` long. */
function textOf(chars: number, fill = 'x'): string {
  return fill.repeat(chars - 2);
}

function entriesMap(entries: EarlierEntry[]): Map<string, EarlierEntry> {
  return new Map(entries.map((e) => [e.stepId, e]));
}

const attribution = { tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VALUE_OFFLOAD_ENABLED;
});

describe('the stored step-output shape', () => {
  // The run that exposed this: at s6 the registry held s1=2,603, s2=546,
  // s3=4,982 and s4=321 characters — ~8,480 with framing, about 300 over the
  // one budget the whole section shared — and the deterministic bound cut
  // every string to 200 characters. s3's research answer reached the step as
  // its preamble and nothing else.
  it('renders all four in full, s3 intact, with no marker and no materialisation', async () => {
    const s3Answer = 'Below are three distinct, *current, vendor-stated* ways these platforms position themselves '
      + 'differently.\n\n| Platform | Concrete differentiator |\n|---|---|\n'
      + '| A | more payment-provider choice |'.padEnd(4_600, ' detail')
      + '\n| C | the last row, which the cut removed |';
    // Padded to the sizes the snapshot recorded.
    const sized = (obj: Record<string, unknown>, key: string, chars: number): Record<string, unknown> => {
      const without = serializeForPrompt({ ...obj, [key]: '' }).length;
      const padded = { ...obj, [key]: `${String(obj[key] ?? '')}`.padEnd(chars - without, '.') };
      // JSON escaping lengthens a newline; take the difference back off the padding.
      const over = serializeForPrompt(padded).length - chars;
      return { ...padded, [key]: (padded[key] as string).slice(0, (padded[key] as string).length - over) };
    };
    const values: Record<string, unknown> = {
      s1: sized({ content: 'Shopify homepage' }, 'content', 2_603),
      s2: sized({ status: 'sourced', hero_headline: 'The one commerce platform' }, 'hero_headline', 546),
      s3: sized({ answer: s3Answer, sources: [{ url: 'https://example.com/a' }] }, 'answer', 4_982),
      s4: sized({ __stepFailed: true, stepId: 's4', error: '[UNRESOLVABLE_TOOL] web_search', note: 'This step did NOT run.' }, 'note', 321),
    };
    const entries = [
      entry('s1', values.s1, { producedBy: 'web_fetch_advanced' }),
      entry('s2', values.s2),
      entry('s3', values.s3, { producedBy: 'web_research' }),
      entry('s4', values.s4, { failed: true }),
    ];
    expect(entries.map((e) => e.chars)).toEqual([2_603, 546, 4_982, 321]);
    expect(entries.map((e) => e.chars).reduce((a, b) => a + b, 0)).toBeGreaterThan(VALUE_BUDGET);
    for (const e of entries) expect(e.chars).toBeLessThanOrEqual(VALUE_BUDGET);

    const step = {
      stepId: 's6',
      description: 'Use the positioning object from step s2, the competitor research from step s3, and the news object from step s5.',
    };
    const referenced = stepsReferencedBy(step, ['s1', 's2', 's3', 's4']);
    expect(referenced).toEqual(['s2', 's3']);

    const plan = planEarlierOutputs(entries, { referenced, ceiling: CEILING, valueBudget: VALUE_BUDGET });
    expect(plan.full.sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(plan.stub).toEqual([]);
    expect(plan.omitted).toEqual([]);

    const prepared = new Map<string, PreparedView>();
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, prepared, CEILING, VALUE_BUDGET);
    expect(out.text).toContain('the last row, which the cut removed');
    expect(out.text).toContain(serializeForPrompt(values.s3));
    expect(out.text).not.toContain('…[truncated:');
    expect(out.text).not.toContain('[TRUNCATED:');
    expect(out.shown.sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(out.stubbed).toEqual([]);
    expect(out.chars).toBe(out.text.length);
    expect(out.chars).toBeLessThanOrEqual(CEILING);
    expect(mockCompress).not.toHaveBeenCalled();
  });
});

describe('a registry over the per-value budget in total but under it per value', () => {
  it('produces a section with no truncation marker', () => {
    const values: Record<string, unknown> = {
      a: textOf(3_000), b: textOf(3_000), c: textOf(3_000),
    };
    const entries = [entry('a', values.a), entry('b', values.b), entry('c', values.c)];
    const plan = planEarlierOutputs(entries, { referenced: [], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.text).not.toContain('…[truncated:');
    expect(out.shown.length).toBe(3);
  });
});

describe('identity', () => {
  it('two earlier steps with the same primitive value are both present, keyed by id', () => {
    const values: Record<string, unknown> = { s1: 'same', s2: 'same' };
    const entries = [entry('s1', 'same'), entry('s2', 'same')];
    const plan = planEarlierOutputs(entries, { referenced: [], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.text).toContain('s1: "same"');
    expect(out.text).toContain('s2: "same"');
  });
});

describe('references', () => {
  it('matches the graph\'s own ids, whatever their shape', () => {
    const known = ['step-1', 'wait-48h', 'fetch_thread'];
    expect(stepsReferencedBy(
      { stepId: 'judge', description: 'Using the thread from step-1 and the wait from wait-48h' }, known,
    )).toEqual(['step-1', 'wait-48h']);
    expect(stepsReferencedBy({ stepId: 's4', description: 'Combine steps s2 and s3.' }, ['s1', 's2', 's3']))
      .toEqual(['s2', 's3']);
  });

  it('does not match an id inside a longer id', () => {
    expect(stepsReferencedBy({ stepId: 'x', description: 'read s12 first' }, ['s1', 's12'])).toEqual(['s12']);
    expect(stepsReferencedBy({ stepId: 'x', description: 'read step-10' }, ['step-1', 'step-10'])).toEqual(['step-10']);
  });

  it('is first-mention order, not graph order', () => {
    expect(stepsReferencedBy(
      { stepId: 's4', description: 'Use the news from s3, then the positioning from s1' }, ['s1', 's2', 's3'],
    )).toEqual(['s3', 's1']);
    expect(stepsReferencedBy(
      {
        stepId: 's4',
        description: 'Use the news from s3, then the positioning from s1',
        toolInputTemplate: '{"x": "{{steps.s2.x}}"}',
      },
      ['s1', 's2', 's3'],
    )).toEqual(['s3', 's1', 's2']);
  });

  it('reads template and condition forms, deduplicated', () => {
    expect(stepsReferencedBy(
      { stepId: 's4', description: '{{steps.s2.body}} and again {{steps.s2.subject}}', condition: '$.steps.s1.ok == true' },
      ['s1', 's2', 's3'],
    )).toEqual(['s2', 's1']);
  });

  it('never returns the step itself or an unknown id', () => {
    expect(stepsReferencedBy({ stepId: 's2', description: 's2 reads s9 and s1' }, ['s1', 's2'])).toEqual(['s1']);
  });
});

describe('exact stub costs', () => {
  it('costs each stub by the line it would actually get, and the final text fits', () => {
    const longId = 'a'.repeat(100);
    const values: Record<string, unknown> = {
      [longId]: textOf(9_000),
      tool: textOf(9_000),
      whole: textOf(9_000),
      failed: { __stepFailed: true, stepId: 'failed', error: 'e'.repeat(880), note: 'n' },
    };
    const entries = [
      entry(longId, values[longId]),
      entry('tool', values.tool, { producedBy: 't'.repeat(60) }),
      entry('whole', values.whole, { producedBy: 'complete_tool', mustBeWhole: true }),
      entry('failed', values.failed, { failed: true }),
    ];
    // A ceiling that admits nothing in full: the plan is stubs alone.
    const ceiling = 1_200;
    const plan = planEarlierOutputs(entries, { referenced: [], ceiling, valueBudget: VALUE_BUDGET });
    expect(plan.full).toEqual([]);
    // Every kept stub's planned cost is its generated length.
    const header = 'Earlier step outputs (by step id):';
    let planned = header.length + 1;
    for (const id of plan.stub) planned += stubFor(entries.find((e) => e.stepId === id)!, null).length + 1;
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), ceiling, VALUE_BUDGET);
    const noticeLen = plan.omitted.length > 0
      ? `[${plan.omitted.length} additional earlier outputs omitted from this prompt.]`.length + 1
      : 0;
    expect(out.chars).toBe(planned + noticeLen - 1);
    expect(out.chars).toBeLessThanOrEqual(ceiling);
    expect(mockCompress).not.toHaveBeenCalled();
  });
});

describe('stubs alone over the ceiling', () => {
  it('keeps the highest-priority stubs that fit and one counted omission notice', () => {
    const values: Record<string, unknown> = {};
    const entries: EarlierEntry[] = [];
    for (let i = 1; i <= 60; i++) {
      values[`s${i}`] = textOf(9_000);
      entries.push(entry(`s${i}`, values[`s${i}`], { producedBy: 'web_research' }));
    }
    const oneStub = stubFor(entries[0], null).length + 1;
    const header = 'Earlier step outputs (by step id):'.length + 1;
    // Room for twelve stubs (eleven of them with a three-character id, one
    // character longer than `oneStub`) and the notice, not thirteen.
    const ceiling = header + 12 * oneStub + 11 + 60;
    const plan = planEarlierOutputs(entries, { referenced: ['s7'], ceiling, valueBudget: VALUE_BUDGET });
    expect(plan.full).toEqual([]);
    expect(plan.stub.length).toBe(12);
    expect(plan.stub[0]).toBe('s7');            // referenced first
    expect(plan.stub.slice(1)).toEqual(['s60', 's59', 's58', 's57', 's56', 's55', 's54', 's53', 's52', 's51', 's50']);
    expect(plan.omitted.length).toBe(48);
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), ceiling, VALUE_BUDGET);
    expect(out.text).toContain('[48 additional earlier outputs omitted from this prompt.]');
    expect(out.omitted.length).toBe(48);
    expect(out.chars).toBeLessThanOrEqual(ceiling);
    expect(mockCompress).not.toHaveBeenCalled();
  });
});

describe('the ceiling on the final text', () => {
  it('shows the referenced oldest entry and the newest that fit, stubs the rest, under the ceiling', () => {
    const values: Record<string, unknown> = {};
    const entries: EarlierEntry[] = [];
    for (let i = 1; i <= 7; i++) {
      values[`s${i}`] = textOf(VALUE_BUDGET);
      entries.push(entry(`s${i}`, values[`s${i}`]));
    }
    for (const e of entries) expect(e.chars).toBe(VALUE_BUDGET);
    const plan = planEarlierOutputs(entries, { referenced: ['s1'], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    expect(plan.full[0]).toBe('s1');
    expect(plan.full.slice(1)).toEqual(['s7', 's6']);
    expect(plan.stub).toEqual(['s5', 's4', 's3', 's2']);
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.shown).toEqual(['s1', 's7', 's6']);
    expect(out.stubbed).toEqual(['s5', 's4', 's3', 's2']);
    expect(out.chars).toBeLessThanOrEqual(CEILING);
    // Layout is graph order, whatever the priority.
    expect(out.text.indexOf('\ns1: ')).toBeLessThan(out.text.indexOf('\n[s2:'));
    expect(out.text.indexOf('\n[s5:')).toBeLessThan(out.text.indexOf('\ns6: '));
  });

  it('demotes one full entry when a parked note ran longer than reserved, and still fits', () => {
    // Three oversized entries whose materialised views are a summary at
    // exactly the budget plus a parked note longer than FRAME_RESERVE.
    const longPath = 'run-values/' + 'p'.repeat(200) + '.json';
    const values: Record<string, unknown> = {};
    const entries: EarlierEntry[] = [];
    const prepared = new Map<string, PreparedView>();
    for (let i = 1; i <= 3; i++) {
      values[`s${i}`] = textOf(20_000);
      entries.push(entry(`s${i}`, values[`s${i}`], { producedBy: 'web_research' }));
      prepared.set(`s${i}`, {
        summary: 's'.repeat(VALUE_BUDGET),
        offloaded: { path: longPath, bytes: 20_000 },
        chars: 20_000,
      });
    }
    expect(offloadNote({ path: longPath, bytes: 20_000 }).length).toBeGreaterThan(FRAME_RESERVE);
    // A ceiling the plan's estimate says admits all three, with little slack.
    const header = 'Earlier step outputs (by step id):'.length + 1;
    const ceiling = header + 3 * (VALUE_BUDGET + FRAME_RESERVE) + 10;
    const plan = planEarlierOutputs(entries, { referenced: [], ceiling, valueBudget: VALUE_BUDGET });
    expect(plan.full.length).toBe(3);
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, prepared, ceiling, VALUE_BUDGET);
    expect(out.shown.length).toBe(2);
    expect(out.stubbed.length).toBe(1);
    // The demoted entry is the lowest priority — the oldest unreferenced — and
    // its stub names the parked path.
    expect(out.stubbed).toEqual(['s1']);
    expect(out.text).toContain(`[s1: 20000 characters from web_research, not shown here; the whole value is in your workspace at ${longPath}]`);
    expect(out.chars).toBeLessThanOrEqual(ceiling);
  });
});

describe('lazy materialisation', () => {
  it('prepares only the entries the plan selected: one compression, one write', async () => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    mockCompress.mockResolvedValue('summary');
    const writer = jest.fn().mockResolvedValue(true);
    const values: Record<string, unknown> = {};
    const entries: EarlierEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      values[`s${i}`] = textOf(20_000);
      entries.push(entry(`s${i}`, values[`s${i}`], { producedBy: 'web_research' }));
    }
    const header = 'Earlier step outputs (by step id):'.length + 1;
    const oneStub = stubFor(entries[0], null).length + 1;
    // Room for one full entry beside nine stubs.
    const ceiling = header + 9 * oneStub + (VALUE_BUDGET + FRAME_RESERVE) + 10;
    const plan = planEarlierOutputs(entries, { referenced: [], ceiling, valueBudget: VALUE_BUDGET });
    expect(plan.full).toEqual(['s10']);
    expect(plan.stub.length).toBe(9);

    const prepared = new Map<string, PreparedView>();
    for (const id of plan.full) {
      await prepareView(entries.find((e) => e.stepId === id)!, values[id], {
        writer, attribution, valueBudget: VALUE_BUDGET,
      }, prepared);
    }
    expect(mockCompress).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(1);
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, prepared, ceiling, VALUE_BUDGET);
    expect(out.shown).toEqual(['s10']);
    // Stubbed entries were never parked: no path, and they say so.
    for (const id of plan.stub) {
      expect(out.text).toContain(`[${id}: 20000 characters from web_research, not shown here and not saved anywhere; if this step depends on it, say so and stop]`);
    }
    expect(out.chars).toBeLessThanOrEqual(ceiling);
  });

  it('memoises by step id: a second step showing the same output prepares nothing', async () => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    mockCompress.mockResolvedValue('summary');
    const writer = jest.fn().mockResolvedValue(true);
    const e = entry('s1', textOf(20_000), { producedBy: 'web_research' });
    const memo = new Map<string, PreparedView>();
    const first = await prepareView(e, textOf(20_000), { writer, attribution, valueBudget: VALUE_BUDGET }, memo);
    const second = await prepareView(e, textOf(20_000), { writer, attribution, valueBudget: VALUE_BUDGET }, memo);
    expect(second).toBe(first);
    expect(mockCompress).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('a fresh memo — the next execution segment — prepares once more', async () => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    mockCompress.mockResolvedValue('summary');
    const writer = jest.fn().mockResolvedValue(true);
    const e = entry('s1', textOf(20_000), { producedBy: 'web_research' });
    await prepareView(e, textOf(20_000), { writer, attribution, valueBudget: VALUE_BUDGET }, new Map());
    await prepareView(e, textOf(20_000), { writer, attribution, valueBudget: VALUE_BUDGET }, new Map());
    expect(mockCompress).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenCalledTimes(2);
  });
});

describe('completeness', () => {
  const whole = () => entry('s1', textOf(20_000), { producedBy: 'complete_tool', mustBeWhole: true });

  it('is never summarised: prepareView offloads and does not compress', async () => {
    process.env.VALUE_OFFLOAD_ENABLED = '1';
    const writer = jest.fn().mockResolvedValue(true);
    const view = await prepareView(whole(), textOf(20_000), { writer, attribution, valueBudget: VALUE_BUDGET }, new Map());
    expect(view.summary).toBe('');
    expect(view.offloaded?.path).toBe('run-values/step-output-s1.json');
    expect(mockCompress).not.toHaveBeenCalled();
  });

  it('parked → the handle alone, no summary', () => {
    const e = whole();
    const values = { s1: textOf(20_000) };
    const prepared = new Map<string, PreparedView>([['s1', {
      summary: '', offloaded: { path: 'run-values/step-output-s1.json', bytes: 20_000 }, chars: 20_000,
    }]]);
    const plan = planEarlierOutputs([e], { referenced: ['s1'], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    const out = renderEarlierOutputs(plan, entriesMap([e]), values, prepared, CEILING, VALUE_BUDGET);
    expect(out.text).toContain('Not shown here on purpose');
    expect(out.text).toContain('run-values/step-output-s1.json');
    expect(out.text).not.toContain('xxxxxxxx');
    expect(out.shown).toEqual(['s1']);
  });

  it('not parked and unreferenced → the complete-required stub, no summary', async () => {
    const e = whole();
    const values = { s1: textOf(20_000) };
    const view = await prepareView(e, values.s1, { writer: null, attribution, valueBudget: VALUE_BUDGET }, new Map());
    expect(view.offloaded).toBeNull();
    const prepared = new Map<string, PreparedView>([['s1', view]]);
    const plan = planEarlierOutputs([e], { referenced: [], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    expect(plan.full).toEqual(['s1']);
    const out = renderEarlierOutputs(plan, entriesMap([e]), values, prepared, CEILING, VALUE_BUDGET);
    expect(out.text).toContain('[s1: 20000 characters from complete_tool, a result this step may only use WHOLE; it is too large for this prompt and was not saved anywhere. Do not answer from memory of it; if this step depends on it, say so and stop]');
    expect(out.text).not.toContain('xxxxxxxx');
    expect(out.shown).toEqual([]);
    expect(out.stubbed).toEqual(['s1']);
    expect(mockCompress).not.toHaveBeenCalled();
  });

  it('fits → verbatim, like any other value', () => {
    const e = entry('s1', textOf(500), { producedBy: 'complete_tool', mustBeWhole: true });
    const values = { s1: textOf(500) };
    const plan = planEarlierOutputs([e], { referenced: [], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    const out = renderEarlierOutputs(plan, entriesMap([e]), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.text).toContain(`s1 (from complete_tool): ${serializeForPrompt(values.s1)}`);
  });
});

describe('failed placeholders', () => {
  it('rank above unreferenced successes and are shown in full when there is room', () => {
    const values: Record<string, unknown> = {
      s1: textOf(VALUE_BUDGET),
      s2: { __stepFailed: true, stepId: 's2', error: 'tool missing', note: 'This step did NOT run.' },
    };
    for (let i = 3; i <= 10; i++) values[`s${i}`] = textOf(VALUE_BUDGET);
    const entries = Object.keys(values).map((id) => entry(id, values[id], { failed: id === 's2' }));
    const plan = planEarlierOutputs(entries, { referenced: ['s1'], ceiling: CEILING, valueBudget: VALUE_BUDGET });
    expect(plan.order.slice(0, 2)).toEqual(['s1', 's2']);
    expect(plan.full).toContain('s1');
    expect(plan.full).toContain('s2');
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.text).toContain('"__stepFailed":true');
    expect(out.chars).toBeLessThanOrEqual(CEILING);
  });

  it('are stubbed, not dropped, when the ceiling admits only the referenced entry', () => {
    const values: Record<string, unknown> = {
      s1: textOf(VALUE_BUDGET),
      s2: { __stepFailed: true, stepId: 's2', error: 'tool missing', note: 'This step did NOT run.' },
      s3: textOf(VALUE_BUDGET),
    };
    const entries = Object.keys(values).map((id) => entry(id, values[id], { failed: id === 's2' }));
    const header = 'Earlier step outputs (by step id):'.length + 1;
    const stubs = entries.reduce((n, e) => n + stubFor(e, null).length + 1, 0);
    const ceiling = header + stubs + (VALUE_BUDGET + FRAME_RESERVE) + 10;
    const plan = planEarlierOutputs(entries, { referenced: ['s1'], ceiling, valueBudget: VALUE_BUDGET });
    expect(plan.full).toEqual(['s1']);
    expect(plan.stub).toContain('s2');
    const out = renderEarlierOutputs(plan, entriesMap(entries), values, new Map(), ceiling, VALUE_BUDGET);
    expect(out.text).toContain('[s2: this step did NOT run; its result is unknown, NOT empty]');
    expect(out.omitted).toEqual([]);
  });
});

describe('partial interpolation', () => {
  // `{{steps.s3.answer}}` puts `answer` in the objective and nothing else. The
  // section still carries the whole of s3, `sources` included: an interpolated
  // field may appear twice, a field that was not interpolated must not vanish.
  it('keeps the fields the objective did not interpolate', () => {
    const values = { s3: { answer: 'A', sources: [{ url: 'https://example.com/src' }] } };
    const e = entry('s3', values.s3, { producedBy: 'web_research' });
    const plan = planEarlierOutputs([e], {
      referenced: stepsReferencedBy({ stepId: 's6', description: 'Say {{steps.s3.answer}}' }, ['s3']),
      ceiling: CEILING, valueBudget: VALUE_BUDGET,
    });
    const out = renderEarlierOutputs(plan, entriesMap([e]), values, new Map(), CEILING, VALUE_BUDGET);
    expect(out.text).toContain('https://example.com/src');
    expect(out.text).toContain('"answer":"A"');
  });
});

describe('nothing earlier', () => {
  it('plans nothing', () => {
    expect(planEarlierOutputs([], { referenced: [], ceiling: CEILING, valueBudget: VALUE_BUDGET }))
      .toEqual({ full: [], stub: [], omitted: [], order: [] });
  });
});
