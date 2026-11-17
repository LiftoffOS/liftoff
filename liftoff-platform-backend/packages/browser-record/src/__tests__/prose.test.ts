import {
  describeAction, describeCall, describeSegment, describeStep, gapPhrase, quoted,
  type RecordedAction, type RecordedCall, type RecordedSegment, type RecordedStep,
} from '../index';

const ORDERS = 'https://shop.example.com/orders?status=open&page=2';
const DOCS = 'https://docs.example.org/guide/install';
const FORM = 'https://forms.example.net/intake';

function action(over: Partial<RecordedAction> & { kind: string; url: string; at: string }): RecordedAction {
  return {
    tag: '', role: '', name: '', inputType: '', value: '', valueDisposition: 'none', detail: '',
    urlTruncated: false, nameTruncated: false, valueTruncated: false, detailTruncated: false,
    urlProtectedDataOmitted: false, nameProtectedDataOmitted: false, detailProtectedDataOmitted: false,
    ...over,
  };
}

function segment(startedAt: string, endedAt: string | null, steps: RecordedAction[], over: Partial<RecordedSegment> = {}): RecordedSegment {
  return { tool: 'person_takeover', steps, live: false, captureGap: false, gapReason: '', startedAt, endedAt, ...over };
}

function step(over: Partial<RecordedStep> = {}): RecordedStep {
  return {
    type: 'act', action: 'click · Order 1042', pageUrl: ORDERS,
    actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '',
    pageUrlProtectedDataOmitted: false, at: null, ...over,
  };
}

function call(over: Partial<RecordedCall> = {}): RecordedCall {
  return {
    tool: 'navigate_browser_session', instruction: DOCS, outcome: `opened ${DOCS}; title: Install`,
    personTookOver: false, steps: null, createdAt: '2026-09-21T21:02:40Z',
    instructionTruncated: false, outcomeTruncated: false,
    instructionProtectedDataOmitted: false, outcomeProtectedDataOmitted: false,
    captureGap: false, gapReason: '', ...over,
  };
}

describe('describeSegment', () => {
  it('renders every action kind, the page named once when it changes, values quoted with JSON escaping and control characters removed', () => {
    const seg = segment('2026-09-15T22:05:07Z', '2026-09-15T22:06:39Z', [
      action({ kind: 'navigate', url: FORM, at: '2026-09-15T22:05:08Z' }),
      action({ kind: 'click', url: FORM, tag: 'input', role: 'textbox', name: 'Full name', inputType: 'text', at: '2026-09-15T22:05:10Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Full name', inputType: 'text', value: 'Ada "Countess" Lovelace', valueDisposition: 'recorded', at: '2026-09-15T22:05:20Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', valueDisposition: 'authentication_omitted', at: '2026-09-15T22:05:25Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Card number', inputType: 'text', valueDisposition: 'payment_omitted', at: '2026-09-15T22:05:26Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'National ID', inputType: 'text', valueDisposition: 'sensitive_identity_omitted', at: '2026-09-15T22:05:27Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: '', name: 'Attachment', inputType: 'file', valueDisposition: 'file_omitted', at: '2026-09-15T22:05:28Z' }),
      action({ kind: 'change', url: FORM, tag: 'textarea', role: 'textbox', name: 'Notes', valueDisposition: 'sensitive_text_omitted', at: '2026-09-15T22:05:29Z' }),
      action({ kind: 'enter', url: FORM, tag: 'input', role: 'textbox', name: 'Search', value: 'refund', valueDisposition: 'recorded', at: '2026-09-15T22:05:30Z' }),
      action({ kind: 'submit', url: FORM, tag: 'form', role: 'form', name: 'Intake', at: '2026-09-15T22:05:31Z' }),
      action({ kind: 'key', url: DOCS, tag: 'body', role: '', name: '', detail: 'Ctrl+F', at: '2026-09-15T22:05:40Z' }),
      action({ kind: 'scroll', url: DOCS, detail: 'scrolled to 40% of the page', at: '2026-09-15T22:05:41Z' }),
      action({ kind: 'drag', url: DOCS, tag: 'div', role: 'listitem', name: 'Step 2', detail: 'the Step 1 card', at: '2026-09-15T22:05:42Z' }),
      action({ kind: 'contextmenu', url: DOCS, tag: 'a', role: 'link', name: 'Download', at: '2026-09-15T22:05:43Z' }),
      action({ kind: 'hover', url: DOCS, tag: 'button', role: 'button', name: 'Copy', at: '2026-09-15T22:05:44Z' }),
    ]);
    expect(describeSegment(seg)).toBe(
      'The person drove the browser themselves (22:05:07Z to 22:06:39Z): '
      + `opened ${FORM}; `
      + 'clicked textbox "Full name"; '
      + 'entered "Ada \\"Countess\\" Lovelace" in textbox "Full name"; '
      + 'entered authentication data in textbox "Password" (not recorded); '
      + 'entered payment data in textbox "Card number" (not recorded); '
      + 'entered sensitive identity data in textbox "National ID" (not recorded); '
      + 'selected a file in input "Attachment" (not recorded); '
      + 'entered sensitive credential-shaped text in textbox "Notes" (not recorded); '
      + 'pressed Enter in textbox "Search" ("refund"); '
      + 'submitted form "Intake"; '
      + `on ${DOCS}; `
      + 'pressed Ctrl+F in an unnamed body; '
      + 'scrolled to 40% of the page; '
      + 'dragged the Step 1 card to listitem "Step 2"; '
      + 'opened the context menu on link "Download"; '
      + 'hovered over button "Copy"',
    );
  });

  it('renders the three suffixes, each closed gap reason as its phrase, and an unknown reason generically', () => {
    const steps = [action({ kind: 'click', url: ORDERS, tag: 'a', role: 'link', name: 'Order 1042', at: '2026-09-15T22:12:20Z' })];
    const base = `The person drove the browser themselves (from 22:12:00Z): on ${ORDERS}; clicked link "Order 1042"`;
    expect(describeSegment(segment('2026-09-15T22:12:00Z', null, steps, { captureGap: true, gapReason: 'lost_owner', live: true, stepsTruncated: true })))
      .toBe(`${base} [part of this segment was not observed: the browser was handed to another instance] [still driving] [older actions omitted from this read]`);
    for (const [reason, phrase] of [
      ['cap', 'the action limit was reached'],
      ['disabled', 'capture was off'],
      ['never_attached', 'the recorder could not attach'],
      ['frame_unavailable', 'a page or frame could not be observed'],
      ['not_answered', 'the browser did not answer'],
      ['something_new', 'part of it was not observed'],
    ]) {
      expect(describeSegment(segment('2026-09-15T22:12:00Z', null, steps, { captureGap: true, gapReason: reason })))
        .toBe(`${base} [part of this segment was not observed: ${phrase}]`);
      expect(gapPhrase(reason)).toBe(phrase);
    }
  });

  it('renders the explicit URL, name, value and detail truncation markers and every protected-text omission flag', () => {
    const seg = segment('2026-09-15T22:12:00Z', '2026-09-15T22:13:00Z', [
      action({ kind: 'navigate', url: `${ORDERS}&token=[redacted]`, urlTruncated: true, urlProtectedDataOmitted: true, at: '2026-09-15T22:12:05Z' }),
      action({ kind: 'change', url: `${ORDERS}&token=[redacted]`, tag: 'input', role: 'textbox', name: 'A very long label', nameTruncated: true, nameProtectedDataOmitted: true, value: 'a long value', valueDisposition: 'recorded', valueTruncated: true, at: '2026-09-15T22:12:10Z' }),
      action({ kind: 'key', url: `${ORDERS}&token=[redacted]`, tag: 'body', detail: 'Ctrl+', detailTruncated: true, detailProtectedDataOmitted: true, at: '2026-09-15T22:12:11Z' }),
      action({ kind: 'change', url: `${ORDERS}&token=[redacted]`, tag: 'input', role: 'textbox', name: 'Old field', valueDisposition: 'legacy_unavailable', at: '2026-09-15T22:12:12Z' }),
    ]);
    expect(describeSegment(seg)).toBe(
      'The person drove the browser themselves (22:12:00Z to 22:13:00Z): '
      + `opened ${ORDERS}&token=[redacted] [address cut short] [part of the address is protected]; `
      + 'entered "a long value" [value cut short] in textbox "A very long label" [name cut short] [part of the name is protected]; '
      + 'pressed Ctrl+ [detail cut short] [part of the detail is protected] in an unnamed body; '
      + 'entered a value in textbox "Old field" (not recorded) '
      + '[part of this segment was not observed: an entered value was not recorded]',
    );
  });

  it('a segment with no observed action says so', () => {
    expect(describeSegment(segment('2026-09-15T22:12:00Z', '2026-09-15T22:13:00Z', [])))
      .toBe('The person drove the browser themselves (22:12:00Z to 22:13:00Z): no action was observed');
  });

  it('a point is one control the person named, without driving', () => {
    const point = action({ kind: 'point', url: ORDERS, tag: 'a', role: 'link', name: 'Sports', at: '2026-09-21T21:05:00Z' });
    expect(describeAction(point)).toBe('pointed at link "Sports"');
    expect(describeSegment(segment('2026-09-21T21:05:00Z', '2026-09-21T21:05:00Z', [point], { kind: 'point' })))
      .toBe(`The person pointed in the browser (21:05:00Z): on ${ORDERS}; pointed at link "Sports"`);
    // A point whose frame could not be observed names no control and carries the gap.
    const blind = action({ kind: 'point', url: ORDERS, detail: 'a control inside an embedded frame that could not be observed', at: '2026-09-21T21:05:00Z' });
    expect(describeSegment(segment('2026-09-21T21:05:00Z', '2026-09-21T21:05:00Z', [blind], { kind: 'point', captureGap: true, gapReason: 'frame_unavailable' })))
      .toBe(`The person pointed in the browser (21:05:00Z): on ${ORDERS}; pointed at an unnamed control [part of this segment was not observed: a page or frame could not be observed]`);
  });

  it('quotes with JSON escaping after removing control characters', () => {
    expect(quoted('a\u0000"b"\nc')).toBe('"a\\"b\\"c"');
  });
});

describe('describeStep', () => {
  it('renders a navigation, an act on a page, and every flag', () => {
    expect(describeStep(step({ type: 'goto', action: DOCS, pageUrl: DOCS }))).toBe(`goto ${DOCS}`);
    expect(describeStep(step())).toBe(`act · click · Order 1042 (on ${ORDERS})`);
    expect(describeStep(step({
      actionTruncated: true, protectedDataOmitted: true, protectedKind: 'sensitive_identity',
      pageUrlTruncated: true, pageUrlProtectedDataOmitted: true,
    }))).toBe(`act · click · Order 1042 (on ${ORDERS}) [action cut short] [sensitive identity value not recorded] [address cut short] [part of the address is protected]`);
    expect(describeStep(step({ protectedDataOmitted: true }))).toBe(`act · click · Order 1042 (on ${ORDERS}) [part of the action is protected]`);
  });
});

describe('describeCall', () => {
  it('renders an assistant row as instruction → outcome, a navigation given its verb', () => {
    expect(describeCall(call())).toBe(`open ${DOCS} → opened ${DOCS}; title: Install`);
    expect(describeCall(call({ tool: 'run_browser_task', instruction: 'find the cheapest flight', outcome: 'Found one at $120.' })))
      .toBe('find the cheapest flight → Found one at $120.');
    expect(describeCall(call({ tool: 'read_active_browser_session', instruction: '', outcome: `read ${DOCS}` })))
      .toBe(`read active browser session → read ${DOCS}`);
  });

  it('renders up to twelve steps by default, fewer when asked, and counts the rest', () => {
    const steps = Array.from({ length: 15 }, (_, i) => step({ action: `click · Order ${1000 + i}` }));
    const rendered = describeCall(call({ tool: 'run_browser_task', instruction: 'work the orders', outcome: 'Done.', steps }));
    expect(rendered).toContain('click · Order 1011');
    expect(rendered).not.toContain('click · Order 1012');
    expect(rendered).toContain('[3 more steps not shown]');
    const six = describeCall(call({ tool: 'run_browser_task', instruction: 'work the orders', outcome: 'Done.', steps }), { maxSteps: 6 });
    expect(six).toContain('click · Order 1005');
    expect(six).not.toContain('click · Order 1006');
    expect(six).toContain('[9 more steps not shown]');
    const one = describeCall(call({ tool: 'run_browser_task', instruction: 'work the orders', outcome: 'Done.', steps: [steps[0]] }));
    expect(one).toBe(`work the orders → Done. (steps: act · click · Order 1000 (on ${ORDERS}))`);
    // An empty list is a loop that ran and took no step: nothing is listed.
    expect(describeCall(call({ tool: 'run_browser_task', instruction: 'x', outcome: 'y', steps: [] }))).toBe('x → y');
    // A host that renders the steps as sub-lines of its own asks for none in
    // the line, and gets no count either: the steps are not left out.
    expect(describeCall(call({ tool: 'run_browser_task', instruction: 'work the orders', outcome: 'Done.', steps }), { maxSteps: 0 }))
      .toBe('work the orders → Done.');
  });

  it('renders every flag, the takeover and the gap', () => {
    expect(describeCall(call({
      instructionTruncated: true, instructionProtectedDataOmitted: true,
      outcomeTruncated: true, outcomeProtectedDataOmitted: true,
      personTookOver: true, captureGap: true, gapReason: 'disconnected', stepsTruncated: true,
    }))).toBe(
      `open ${DOCS} → opened ${DOCS}; title: Install `
      + '[instruction cut short] [part of the instruction is protected] [outcome cut short] [part of the outcome is protected] '
      + '[the person took over] [part of this task was not observed: the browser disconnected] [older steps omitted from this record]',
    );
  });
});
