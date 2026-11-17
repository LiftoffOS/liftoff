// A reply that says nothing was created, on a run that created something.
//
// A run can create a document (a battle card, say) during its retries and
// close with "No battle card was created or changed." while the document is
// there, and the agent's own `search_documents` call finds it on the very next
// turn.
//
// Corrected at the DELIVERY boundary. The graph-shaped version of this throws
// into workflow recovery, and recovery can replay the very write the report is
// about — turning the fix into a cause of the duplicate-write defect beside it.

const mockComplete = jest.fn();
jest.mock('../../llm/client', () => ({
  llmClient: {
    complete: (...args: unknown[]) => mockComplete(...args),
    modelSelectionFor: jest.fn(() => undefined),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  correctReplyContradictingTheLedger,
  deniesAnyChange,
  successfulWrites,
  type LedgerCall,
} from '../ledger-contradiction';

const CREATE = 'google-docs-8fd9fc68__create_document_markdown';
const SEARCH = 'google-docs-8fd9fc68__search_documents';

const BASE = {
  tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
  agentId: '90816ede-009b-4c55-a20c-2de91e7590d6',
  threadId: 'da07be9a-dac5-4e9e-bff3-3453d16d20aa',
  invocationId: 'e30260fb-bd1b-4682-8ee0-50d7257ab9a0',
  userMessage: 'so where is my report',
};

const CARD_WRITE: LedgerCall = {
  name: CREATE,
  input: { title: 'Acme: Battle Card: AllAgents' },
  success: true,
  result: { documentId: '10OzC7pBCTblriXI2RxxfUpBASrBtaTq7' },
};

beforeEach(() => {
  mockComplete.mockReset();
  mockComplete.mockResolvedValue({ content: 'The battle card for AllAgents is in "Acme: Battle Card: AllAgents".' });
});

describe('deniesAnyChange', () => {
  it.each([
    'No battle card was created or changed.',
    'Nothing was created.',
    'Nothing has been changed.',
    'No documents were updated.',
    'The battle card was not created.',
    'I did not create any documents.',
    'No changes were made.',
    'No new document has been written.',
  ])('reads %p as a denial', (t) => {
    expect(deniesAnyChange(t)).toBe(true);
  });

  it.each([
    'I wrote the battle card for AllAgents and linked it in the digest.',
    'Corvid Route did not change its pricing this week.',
    'No competitor was added to the watch list by anyone else.',
    'The digest is ready.',
    // The passive form of a statement about the world. "page" is a thing this
    // agent both READS and produces, so the produced-noun test alone matches it;
    // the attribution is what says whose page it is.
    'The pricing page was not updated by Corvid Route.',
    'No battle card was created by "Competitor Comparison Writer".',
    '',
  ])('leaves %p alone', (t) => {
    expect(deniesAnyChange(t)).toBe(false);
  });

  it('still reads a denial the run makes about its OWN work', () => {
    // The attribution exclusion must not swallow the case this exists for. A
    // first-person or unattributed denial is still a denial, and neither `by the
    // way` nor `by us` names a third party.
    expect(deniesAnyChange('No battle card was created or changed.')).toBe(true);
    expect(deniesAnyChange('I did not create the card, by the way.')).toBe(true);
    expect(deniesAnyChange('No document was created by us this week.')).toBe(true);
  });

  it('reads it sentence by sentence, so a listing plus a caveat is not a denial', () => {
    // A reply that says what it wrote and then bounds the claim is correct, and
    // rewriting it would replace a good reply with a re-derived one.
    const reply = 'I wrote the battle card for AllAgents. No other documents were changed.';
    // The caveat IS a denial sentence on its own, which is why the check is a
    // gate on asking again rather than a verdict: the model is handed the record
    // and writes the reply.
    expect(deniesAnyChange(reply)).toBe(true);
    expect(deniesAnyChange('I wrote the battle card for AllAgents.')).toBe(false);
  });

  it('is null-safe', () => {
    expect(deniesAnyChange(null)).toBe(false);
    expect(deniesAnyChange(undefined)).toBe(false);
  });
});

describe('successfulWrites', () => {
  it('counts a create', () => {
    expect(successfulWrites([CARD_WRITE])).toEqual([CARD_WRITE]);
  });

  it('does not count a read', () => {
    expect(successfulWrites([{ name: SEARCH, success: true, result: [] }])).toEqual([]);
  });

  it('does not count a write that FAILED', () => {
    expect(successfulWrites([{ ...CARD_WRITE, success: false, error: 'rate limited' }])).toEqual([]);
  });

  it('counts a call with no success flag, which is how a collected call arrives', () => {
    // The handler keeps two records: a completed call carries the flag and a
    // collected one (seen starting, never finishing) does not. Treating the
    // second as a failure would lose exactly the writes a cut-off turn made.
    expect(successfulWrites([{ name: CREATE, input: {} }])).toHaveLength(1);
  });

  it('never counts the agent writing in its own notebook', () => {
    // record_step_output / report_task_outcome / audit_log leave the process
    // nowhere, so a person was never told about one.
    expect(successfulWrites([
      { name: 'record_step_output', success: true },
      { name: 'mcp__liftoff-tool-gateway__report_task_outcome', success: true },
      { name: 'audit_log', success: true },
    ])).toEqual([]);
  });

  it('counts one call once, however many times the handler noted it', () => {
    // The handler collects a call when it STARTS and completes it when it
    // FINISHES, so a single create is usually in both records. Counted twice, the
    // digest tells the model two documents exist and it says so to a person.
    const started: LedgerCall = { name: CREATE, input: CARD_WRITE.input };
    const out = successfulWrites([started, CARD_WRITE]);
    expect(out).toHaveLength(1);
    // And the entry that carries the RESULT is the one kept, because that is the
    // one the digest can report.
    expect(out[0]!.result).toEqual(CARD_WRITE.result);
  });

  it('keeps the result whichever order the two records arrive in', () => {
    const started: LedgerCall = { name: CREATE, input: CARD_WRITE.input };
    expect(successfulWrites([CARD_WRITE, started])[0]!.result).toEqual(CARD_WRITE.result);
  });

  it('keeps two DIFFERENT writes apart', () => {
    const other: LedgerCall = { name: CREATE, input: { title: 'Card: Corvid' }, success: true, result: { documentId: 'b' } };
    expect(successfulWrites([CARD_WRITE, other])).toHaveLength(2);
  });

  it('requires a RECOGNISED mutating verb, never an unrecognised name', () => {
    // `classifyVendorToolEffect` answers `write` for a matched verb AND for any
    // name it does not recognise, so it cannot tell the two apart. Here the
    // difference decides whether a CORRECT reply gets rewritten.
    expect(successfulWrites([{ name: 'locus-1__reconcile_ledger', success: true }])).toEqual([]);
    expect(successfulWrites([{ name: 'locus-1__update_ledger', success: true }])).toHaveLength(1);
  });
});

describe('the reply that is delivered instead', () => {
  it('asks again from the record, and returns what the model wrote', async () => {
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [{ name: SEARCH, success: true, result: [] }, CARD_WRITE],
    });
    expect(out).toContain('Acme: Battle Card: AllAgents');
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('withholds tools from that completion, because the work already happened', async () => {
    // A nudge that can act is a nudge that can act twice. The one thing that
    // must never come out of correcting a report is another write.
    await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [CARD_WRITE],
    });
    const request = mockComplete.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
  });

  it('hands the completion a digest of the WRITES, not the whole turn', async () => {
    await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [{ name: SEARCH, success: true, result: ['a stale search result'] }, CARD_WRITE],
    });
    const prompt = String(
      ((mockComplete.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]).content,
    );
    expect(prompt).toContain('10OzC7pBCTblriXI2RxxfUpBASrBtaTq7');
    expect(prompt).not.toContain('a stale search result');
  });

  it('does nothing when the reply claims no such thing', async () => {
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'The battle card for AllAgents is written and linked in the digest.',
      calls: [CARD_WRITE],
    });
    expect(out).toBeNull();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('does nothing when the run genuinely changed nothing', async () => {
    // "No battle card was created" is the TRUE answer for a week with nothing to
    // report, and rewriting it would be the same defect pointing the other way.
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [{ name: SEARCH, success: true, result: [] }],
    });
    expect(out).toBeNull();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('delivers the reply it was given when the completion produces nothing', async () => {
    // A reply that says nothing happened is wrong; a reply that says nothing at
    // all is worse.
    mockComplete.mockResolvedValue({ content: '' });
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [CARD_WRITE],
    });
    expect(out).toBeNull();
  });

  it('delivers the reply it was given when the completion fails', async () => {
    mockComplete.mockRejectedValue(new Error('provider 500'));
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [CARD_WRITE],
    });
    expect(out).toBeNull();
  });

  it('does not re-ask when the correction denies the change as well', async () => {
    // The model has answered the question put to it. Asking again buys latency on
    // a turn the person is already waiting on.
    mockComplete.mockResolvedValue({ content: 'Nothing was created this week.' });
    const out = await correctReplyContradictingTheLedger({
      ...BASE,
      replyText: 'No battle card was created or changed.',
      calls: [CARD_WRITE],
    });
    expect(out).toBeNull();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});
