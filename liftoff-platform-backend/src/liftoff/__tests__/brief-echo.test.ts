// The brief does not come back out, and a real answer is never touched.
//
// The first case is a paragraph of the kind that gets past the other
// controls. The rest are the ones that
// decide whether this is safe to have: a colleague quoting the PERSON is not
// leaking, and a colleague writing about the same subject in its own words is
// not either.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { briefEchoReader } from '../brief-echo';
import { forwardedContextForModel } from '../forwarded-context';

const ctx = { tenantId: 't-1', speaker: 'caio', threadId: 'th-1' };

/** The paraphrase half, told to find nothing. These cases are about the
 *  verbatim half, which runs first and needs no model. */
const findsNothing = async (paragraph: string) => ({ removed: false, text: paragraph });

function reader(summary: string, userMessage: string) {
  return briefEchoReader(
    forwardedContextForModel(userMessage, summary, 'Liftoff'),
    userMessage,
    ctx,
    findsNothing,
  );
}

it('removes the brief read out as a preamble, and keeps the answer under it', () => {
  const userMessage = 'then delete the Release Coordinator';
  const summary =
    'The article content came back truncated. Let me confirm the archive behavior is accurate to '
    + 'what you already know, and check if there is more relevant detail you are missing before advising Alex.';
  const r = reader(summary, userMessage)!;

  const reply =
    'The article content came back truncated. Let me confirm the archive behavior is accurate to '
    + 'what you already know, and check if there is more relevant detail you are missing before advising Alex. '
    + 'I have removed the Release Coordinator.';

  const out = r.read(reply);
  expect(out.removed).toBe(2);
  expect(out.text.trim()).toBe('I have removed the Release Coordinator.');
});

it('keeps a reply that says the same thing in its own words', () => {
  // A paraphrase is not caught, and this pins that rather than pretending
  // otherwise: the log line in the reader is how the fuzzy case gets measured
  // before anyone picks a similarity threshold for it.
  const r = reader(
    'They want to know whether archiving an agent destroys its history.',
    'is archiving the same as deleting',
  )!;
  const reply = 'Removing an agent takes it out of your workspace. I can do that now.';
  expect(r.read(reply)).toEqual({ text: reply, removed: 0 });
});

it('never removes the person\'s own words, however much of the brief quotes them', () => {
  // The brief routinely quotes the person, and a colleague confirming what it
  // heard quotes them back. That is the case a naive match would damage.
  const userMessage = 'please archive the Release Coordinator and tell me when it is done';
  const r = reader(`The person said: ${userMessage}`, userMessage)!;
  const reply = 'You asked me to archive the Release Coordinator and tell you when it is done. It is done.';
  expect(r.read(reply)).toEqual({ text: reply, removed: 0 });
});

it('removes the brief\'s own opening, which is ours and not a summary at all', () => {
  const r = reader('They are asking about last week.', 'what happened last week')!;
  const out = r.read(
    'It is not shown to the person: do not repeat it, or any identifier in it, to them. Four runs, all green.',
  );
  expect(out.removed).toBe(1);
  expect(out.text.trim()).toBe('Four runs, all green.');
});

it('keeps a real sentence that happens to share a few words with the brief', () => {
  const r = reader(
    'They are asking about the Release Coordinator and its recent runs.',
    'how is the Release Coordinator doing',
  )!;
  const reply = 'The Release Coordinator ran four times this week and paused once for an approval.';
  expect(r.read(reply).removed).toBe(0);
});

it('has nothing to do when there is no brief', () => {
  expect(briefEchoReader(null, 'anything', ctx)).toBeNull();
  expect(briefEchoReader(forwardedContextForModel('hello', '', 'Liftoff'), 'hello', ctx)).toBeNull();
});

it('does not drop a fenced block that repeats the brief inside it', () => {
  // Code is not prose. A brief that named a value and a reply that shows that
  // value in a block are not the same event, and cutting a line out of a block
  // is worse than the leak.
  const r = reader('They want the cron expression written as 0 9 * * 1 for the Monday report.', 'set it to Mondays at nine')!;
  const reply = 'Here is the schedule:\n\n```\n0 9 * * 1\n```\n';
  expect(r.read(reply).removed).toBe(0);
});

describe('the two halves together', () => {
  it('runs the verbatim half first, and the paraphrase half on what is left', async () => {
    const userMessage = 'then delete the Release Coordinator';
    const summary = 'The article content came back truncated. Confirm the archive behaviour before advising Alex.';
    const seen: string[] = [];
    const r = briefEchoReader(
      forwardedContextForModel(userMessage, summary, 'Liftoff'),
      userMessage,
      ctx,
      async (paragraph) => {
        seen.push(paragraph);
        // A paraphrase the verbatim half cannot see.
        return { removed: true, text: 'I have removed the Release Coordinator.' };
      },
    )!;

    const out = await r.readFully(
      'The article content came back truncated. '
      + 'Let me be sure about what archiving does before I tell you. '
      + 'I have removed the Release Coordinator.',
    );
    // The verbatim sentence never reached the model: it was already gone.
    expect(seen[0]).not.toContain('came back truncated');
    expect(seen[0]).toContain('Let me be sure about what archiving does');
    expect(out.text).toBe('I have removed the Release Coordinator.');
    expect(out.removed).toBe(2);
  });

  it('does not call the model when the verbatim half took everything', async () => {
    const userMessage = 'what happened last week';
    let asked = false;
    const r = briefEchoReader(
      forwardedContextForModel(userMessage, 'They are asking about last week and the four runs it held.', 'Liftoff'),
      userMessage,
      ctx,
      async (p) => { asked = true; return { removed: false, text: p } },
    )!;
    const out = await r.readFully('They are asking about last week and the four runs it held.');
    expect(out.text.trim()).toBe('');
    expect(asked).toBe(false);
  });
});
