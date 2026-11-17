// The reference loop's offline contracts (jev-ultrafast tests/test_agent.py),
// ported: the checkbox/radio/button distinction, invalid operation/target
// answers rejected, all heads in one request and only the matching head
// executes, a click cannot consume a text target, and the divergence — the
// typed value is a Choice over the task's literals.

import { actionSpace, buildStepRequest, chooseFromAnswers, validateChoice } from '../decide';
import { extractLiterals } from '../literals';
import type { PageState } from '../types';

function page(): PageState {
  return {
    url: 'https://example.test/', title: 'Search', text: 'Search', w: 1120, h: 780,
    scroll: { y: 0, height: 780 },
    actions: [
      { id: 'e1', kind: 'fill', label: 'Search', role: 'textbox', value: '', node: 10 },
      { id: 'e2', kind: 'click', label: 'Open Search', role: 'textbox', value: '', node: 10 },
      { id: 'e3', kind: 'click', label: 'Go', role: 'button', value: '', node: 20 },
      { id: 'wait', kind: 'wait', label: 'Wait' },
    ],
    marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint: 'fp',
  };
}

const choice = (ids: string[], selected: string) => ({
  choice: selected, confidence: 1, probabilities: Object.fromEntries(ids.map((i) => [i, i === selected ? 1 : 0])),
});

describe('validateChoice', () => {
  it.each(['unknown', 'nan', 'missing', 'negative', 'non_max', 'confidence'])('rejects an invalid answer: %s', (mutation) => {
    const a = choice(['a', 'b'], 'a') as { choice: string; confidence: number; probabilities: Record<string, number> };
    if (mutation === 'unknown') a.choice = 'invented';
    else if (mutation === 'nan') a.probabilities.a = Number.NaN;
    else if (mutation === 'missing') delete a.probabilities.b;
    else if (mutation === 'negative') a.probabilities.b = -1;
    else if (mutation === 'non_max') a.choice = 'b';
    else a.confidence = 5;
    expect(() => validateChoice(a, ['a', 'b'])).toThrow('Invalid TypeSafe');
  });
});

describe('actionSpace', () => {
  it('one index per node with operation-specific targets', () => {
    const { elements, targets, controls } = actionSpace(page().actions);
    expect(elements).toHaveLength(2);
    expect(elements[0].operations).toEqual(['TYPE_TEXT', 'CLICK']);
    expect(targets.get('TYPE_TEXT')!.get('1')!.id).toBe('e1');
    expect(targets.get('CLICK')!.get('1')!.id).toBe('e2');
    expect(targets.get('CLICK')!.get('2')!.id).toBe('e3');
    expect(controls.has('WAIT')).toBe(true);
  });

  it('distinguishes checkbox, radio and button: only clicks, never TYPE_TEXT', () => {
    const { elements } = actionSpace([
      { id: 'c', kind: 'click', label: 'Free cancellation', node: 30, role: 'checkbox', checked: 'true' },
      { id: 'r', kind: 'click', label: 'Choice', node: 31, role: 'radio', checked: 'false' },
      { id: 'b', kind: 'click', label: 'Buy', node: 32, role: 'button' },
    ]);
    expect(elements.map((e) => e.operations)).toEqual([['CLICK'], ['CLICK'], ['CLICK']]);
    expect(elements[0].checked).toBe('true');
  });

  it('a native select carries code-owned option indexes', () => {
    const { elements, targets } = actionSpace([
      { id: 's1', kind: 'select', label: 'Category → Design', node: 40, role: 'combobox', value: 'Design', current_value: 'All' },
      { id: 's2', kind: 'select', label: 'Category → Coastal', node: 40, role: 'combobox', value: 'Coastal', current_value: 'All' },
    ]);
    expect(elements[0].options?.map((o) => o.index)).toEqual(['1:1', '1:2']);
    expect(targets.get('SELECT')!.get('1:2')!.id).toBe('s2');
  });
});

describe('buildStepRequest and chooseFromAnswers', () => {
  const literals = extractLiterals('Search for "Zurich hotels"');
  const meta = { latencyMs: 10, model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 } };

  it('all heads are one request and only the matching head executes', () => {
    const built = buildStepRequest(page(), 'Find a book', [], literals);
    expect(Object.keys(built.set.questions).sort()).toEqual(['click_target', 'operation', 'type_text_target', 'type_text_value']);
    const d = chooseFromAnswers(built, {
      operation: choice(built.operations, 'TYPE_TEXT'),
      type_text_target: choice(['1'], '1'),
      type_text_value: choice([...built.literalIds, 'none'], 'l1'),
      click_target: { choice: 'invented' },
    }, meta);
    expect(d.operation).toBe('TYPE_TEXT');
    expect(d.target).toBe('1');
    expect(d.choice).toBe('e1');
    expect(d.textId).toBe('l1');
    expect(literals.byId.get('l1')).toBe('Zurich hotels');
  });

  it('a click cannot consume a text target', () => {
    const built = buildStepRequest(page(), 'Find a book', [], literals);
    expect(() => chooseFromAnswers(built, {
      operation: choice(built.operations, 'CLICK'),
      type_text_target: choice(['1'], '1'),
      click_target: choice(['1', '2', '999'], '999'),
    }, meta)).toThrow('Invalid TypeSafe');
  });

  it('a target head for an operation not chosen cannot act; DONE and BLOCKED need no head', () => {
    const built = buildStepRequest(page(), 'Find a book', [], literals);
    const d = chooseFromAnswers(built, { operation: choice(built.operations, 'DONE'), click_target: { choice: 'invented' } }, meta);
    expect(d.operation).toBe('DONE');
    expect(d.target).toBeNull();
    expect(d.choice).toBe('DONE');
  });

  it('the typed value is a literal the task supplied, or none', () => {
    const built = buildStepRequest(page(), 'Find a book', [], extractLiterals('no literals here'));
    expect(built.literalIds).toEqual([]);
    const d = chooseFromAnswers(built, {
      operation: choice(built.operations, 'TYPE_TEXT'),
      type_text_target: choice(['1'], '1'),
      type_text_value: choice(['none'], 'none'),
    }, meta);
    expect(d.textId).toBeNull();
  });

  it('the target head receives control state and the full next-step rules', () => {
    const p = page();
    p.actions.unshift({ id: 'toggle', kind: 'click', label: 'Free cancellation', node: 30, role: 'checkbox', checked: 'true' });
    const built = buildStepRequest(p, 'Book it', [], literals);
    const clickHead = built.set.questions.click_target as { criteria: Record<string, Record<string, string>>; instructions: { rules: string[] } };
    expect(clickHead.criteria['1']).toMatchObject({ role: 'checkbox', checked: 'true' });
    expect(clickHead.instructions.rules).toHaveLength(2);
    expect(built.state).toMatchObject({ page: { url: 'https://example.test/' }, omitted_actions: 0 });
  });
});

describe('extractLiterals', () => {
  it('finds quoted strings, emails, URLs, numbers, dates and parameter values, parameters first', () => {
    const l = extractLiterals('Book "Hotel Adler" for jane@example.com on 2026-10-02 via https://x.test/book, 2 nights', { guests: 3 });
    // The date's parts are not separate numbers, and the URL sheds the comma
    // the sentence hung on it.
    expect([...l.byId.values()]).toEqual(['3', 'Hotel Adler', 'jane@example.com', 'https://x.test/book', '2026-10-02', '2']);
  });
});
