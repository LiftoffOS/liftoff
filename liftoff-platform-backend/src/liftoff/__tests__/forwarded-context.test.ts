// The background one assistant forwards to another is not the person's words,
// and it is not for the person to read either.
//
// It used to be concatenated onto their message and sent as one string, which
// every delegate surface persisted as the USER's row. Then it was persisted as
// its own row, which showed the person a brief written for a model: third
// person about them, with a team's id in it, ending "confirm you are targeting
// that id". It is model-only now; the thread keeps one status line.

import {
  forwardedContextForModel,
  forwardedContextStatus,
  withForwardedContext,
} from '../forwarded-context';

const OPENING =
  'Background from Liftoff, which brought you into this conversation. It is not shown to the person: '
  + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.';

describe('forwardedContextForModel', () => {
  it('frames the summary for the colleague: what it is, that the person does not see it, then the summary', () => {
    const brief = forwardedContextForModel('Yes', 'They want unpaid invoices chased', 'Liftoff');

    // The opening is load-bearing: the Chief AI Officer's prompt keys its
    // hand-over rule on "Background from" (migration 497), and the sentence
    // about identifiers is what stops a colleague repeating an id back.
    expect(brief).toBe(`${OPENING}\n\nThey want unpaid invoices chased`);
  });

  it('names whoever is forwarding', () => {
    expect(forwardedContextForModel('Yes', 'The Watches team costs the most', 'Insights Manager'))
      .toMatch(/^Background from Insights Manager, which brought you into this conversation\./);
    expect(forwardedContextForModel('Yes', 'The person wants the schedule changed', 'Launch Check'))
      .toMatch(/^Background from Launch Check, which brought you/);
  });

  it('forwards nothing when there is no summary', () => {
    expect(forwardedContextForModel('Yes', '', 'Liftoff')).toBeNull();
    expect(forwardedContextForModel('Yes', '   ', 'Liftoff')).toBeNull();
  });

  it('forwards nothing when the summary only repeats the message', () => {
    // The common case for a first request. Forwarding it would put the same
    // sentence in front of the model twice.
    expect(forwardedContextForModel('Chase unpaid invoices', 'Chase unpaid invoices', 'Liftoff')).toBeNull();
    expect(forwardedContextForModel('Chase unpaid invoices', '  chase UNPAID invoices  ', 'Liftoff')).toBeNull();
  });

  it('keeps a summary that merely starts the same way, identifiers included', () => {
    // Only an exact repeat is redundant. A summary that opens with the message
    // and then adds what the colleague cannot see is the whole point, and an
    // id in it is useful to the colleague's tools precisely because nobody
    // else will read it.
    const brief = forwardedContextForModel(
      'Chase unpaid invoices',
      'Chase unpaid invoices, for the three accounts they named earlier (team id 122662dd-de4e-4b0d-8873-50cd6a00daaf)',
      'Liftoff',
    );
    expect(brief).toContain('the three accounts they named earlier');
    expect(brief).toContain('122662dd-de4e-4b0d-8873-50cd6a00daaf');
  });
});

describe('forwardedContextStatus', () => {
  it('is the one line the colleague\'s thread keeps, spelled as workforce-service and liftoff-react spell it', () => {
    // Three places hold this text: this service, workforce-service's copy of
    // the module, and the label liftoff-react falls back to. Their tests pin
    // the same string.
    expect(forwardedContextStatus('Liftoff')).toBe('Liftoff shared background from the conversation so far');
    expect(forwardedContextStatus('Insights Manager')).toBe(
      'Insights Manager shared background from the conversation so far',
    );
  });

  it('never carries the brief', () => {
    const status = forwardedContextStatus('Insights Manager');
    expect(status).not.toContain('\n');
    expect(status).not.toContain('Background from');
  });
});

describe('withForwardedContext', () => {
  it('puts the brief in front of the person\'s words, unchanged', () => {
    expect(withForwardedContext('Yes', 'Background\n\nthey want invoices chased')).toBe(
      'Background\n\nthey want invoices chased\n\nYes',
    );
  });

  it('returns the message alone when nothing was forwarded', () => {
    // Somebody typing on the colleague's own page can see the thread, so there
    // is nothing to forward and nothing should be prepended.
    expect(withForwardedContext('Yes', null)).toBe('Yes');
  });
});
