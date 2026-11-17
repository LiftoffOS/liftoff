// A graph that acts must declare what it produces.
//
// An agent can review a pull request, post a substantive review, and reply
// nothing. The person sees their own message and silence. Every layer below the
// graph works — the turn persists, the tools dispatch, the review lands. If
// nothing anywhere says reporting back is part of the job, nothing is missing
// when it does not happen.
//
// The other places to fix it are the wrong altitude: making the thread
// non-empty, having the platform write a line on the agent's behalf, or teaching
// the chat prompt to ask for the answer. The first two are the platform
// impersonating the agent. The third is a prompt rule, which a model can trade
// away under pressure. This is the same requirement as a contract, at the one
// place that reaches every agent.
import { findMissingReplyContract } from '../reply-contract';
import type { WorkflowStep } from '../types';

const step = (over: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ type: 'tool_call', ...over }) as WorkflowStep;

describe('findMissingReplyContract', () => {
  it('flags the shape that caused it: act, then end, saying nothing', () => {
    const problems = findMissingReplyContract([
      step({ stepId: 's1', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'github__create_review', onSuccess: '' }),
    ]);

    expect(problems.map((p) => p.stepId)).toEqual(['s2']);
    expect(problems[0].message).toMatch(/expectedOutput/);
  });

  it('accepts a terminal step that declares what the person is told', () => {
    // Cron: no reader, so only the DECLARATION rule applies here. The separate
    // producer rule is exercised in its own block below.
    expect(
      findMissingReplyContract([
        step({
          stepId: 's1',
          toolName: 'github__create_review',
          onSuccess: '',
          expectedOutput: 'a short summary of what the review found and what to do about it',
        } as Partial<WorkflowStep> & { stepId: string }),
      ], { type: 'cron' }),
    ).toEqual([]);
  });

  it('treats a missing onSuccess as terminal, not as an unfinished graph', () => {
    // `onSuccess: ''` and no key at all both end the run. Only checking the
    // explicit empty string would let the commonest shape through.
    expect(findMissingReplyContract([step({ stepId: 'only' })])).toHaveLength(1);
  });

  it('does not flag steps in the middle of a graph', () => {
    // The contract is about what the WORKFLOW produces. Demanding a line from
    // every intermediate step would be noise, and noise is how a rule gets
    // ignored.
    expect(
      findMissingReplyContract([
        step({ stepId: 's1', onSuccess: 's2' }),
        step({ stepId: 's2', onSuccess: 's3' }),
        step({ stepId: 's3', onSuccess: '', expectedOutput: 'the answer' }),
      ], { type: 'cron' }),
    ).toEqual([]);
  });

  it('flags EVERY terminal branch, not just the last step in the array', () => {
    // A condition splits the graph. A branch that ends silently is exactly as
    // bad as a linear graph that does, and is easier to miss.
    const problems = findMissingReplyContract([
      step({ stepId: 's1', condition: '$.steps.s0.found == true', onSuccess: 's2', onFailure: 's3' }),
      step({ stepId: 's2', onSuccess: '', expectedOutput: 'what was found' }),
      step({ stepId: 's3', onSuccess: '' }),
    ], { type: 'cron' });
    expect(problems.map((p) => p.stepId)).toEqual(['s3']);
  });

  it('exempts ask_user, whose output is the question itself', () => {
    // A graph that ends by asking has not finished, and the runtime already
    // surfaces the question as a first-class pause.
    expect(
      findMissingReplyContract([step({ stepId: 's1', type: 'ask_user', onSuccess: '' })]),
    ).toEqual([]);
  });

  it('exempts delay, which produces nothing a person receives', () => {
    expect(
      findMissingReplyContract([step({ stepId: 's1', type: 'delay', onSuccess: '' })]),
    ).toEqual([]);
  });

  it('does not accept whitespace as a declaration', () => {
    expect(
      findMissingReplyContract([
        step({ stepId: 's1', onSuccess: '', expectedOutput: '   ' } as Partial<WorkflowStep> & { stepId: string }),
      ]),
    ).toHaveLength(1);
  });

  it('says nothing about an empty or absent graph', () => {
    // Distillation has its own NO_OP_WORKFLOW rule for that; two rules firing on
    // one cause gives the model contradictory feedback to retry against.
    expect(findMissingReplyContract([])).toEqual([]);
    expect(findMissingReplyContract(undefined as unknown as WorkflowStep[])).toEqual([]);
  });

  it('tells the model what a good output looks like, not just that one is missing', () => {
    // Retry feedback that only names the violation gets answered with the
    // cheapest thing that passes — "the review is posted" — which restates the
    // action and still leaves the person to go and look.
    const [problem] = findMissingReplyContract([step({ stepId: 's1', onSuccess: '' })], { type: 'cron' });
    expect(problem.message).toMatch(/what they are TOLD/);
    expect(problem.message).toMatch(/never ran/);
  });
});

// Declaring an output is not producing one — but only where someone is reading.
//
// Shape 2 shipped first and can be satisfied hollowly: a `tool_call` step's
// output is the TOOL's response, so a graph ending on `github__create_review`
// could declare "a summary of what the review found" while containing no step
// able to write it.
//
// A first attempt at this rule applied it to EVERY graph and was reverted before
// shipping. It would have added a model call to every cron fire to produce a
// summary with no reader — a permanent cost to close a gap that only exists when
// somebody is waiting.
describe('a terminal step must be able to produce what it declares', () => {
  const MANUAL = { type: 'manual' };
  const CRON = { type: 'cron' };

  it('refuses a graph that ends on a tool call when a person is waiting', () => {
    const problems = findMissingReplyContract(
      [step({
        stepId: 's1',
        toolName: 'github__create_review',
        onSuccess: '',
        expectedOutput: 'a summary of what the review found',
      } as Partial<WorkflowStep> & { stepId: string })],
      MANUAL,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/nothing in this workflow produces an answer/);
    expect(problems[0].message).toMatch(/llm_reason/);
  });

  it('allows the same graph on a cron trigger, where nobody is reading', () => {
    // The revert, encoded. A cron agent that ends by creating a ticket has no
    // reader and its output IS the ticket.
    expect(
      findMissingReplyContract(
        [step({
          stepId: 's1',
          toolName: 'linear__create_ticket',
          onSuccess: '',
          expectedOutput: 'the ticket that was raised',
        } as Partial<WorkflowStep> & { stepId: string })],
        CRON,
      ),
    ).toEqual([]);
  });

  it('allows it on an event trigger too', () => {
    expect(
      findMissingReplyContract(
        [step({
          stepId: 's1', toolName: 'linear__create_ticket', onSuccess: '', expectedOutput: 'the ticket',
        } as Partial<WorkflowStep> & { stepId: string })],
        { type: 'event' },
      ),
    ).toEqual([]);
  });

  it('accepts act-then-report, the shape it is steering toward', () => {
    expect(
      findMissingReplyContract(
        [
          step({ stepId: 's1', toolName: 'github__create_review', onSuccess: 's2' }),
          step({
            stepId: 's2',
            type: 'llm_reason',
            onSuccess: '',
            expectedOutput: 'a summary of what the review found and what to do about it',
          } as Partial<WorkflowStep> & { stepId: string }),
        ],
        MANUAL,
      ),
    ).toEqual([]);
  });

  it('accepts a terminal tool call whose purpose IS telling someone', () => {
    // Demanding a reasoning step after a Slack post would add a hop that says
    // nothing new. Same predicate the announce gate uses.
    expect(
      findMissingReplyContract(
        [step({
          stepId: 's1',
          toolName: 'slack_send_message',
          onSuccess: '',
          expectedOutput: 'the review summary, posted to the channel',
        } as Partial<WorkflowStep> & { stepId: string })],
        MANUAL,
      ),
    ).toEqual([]);
    // …including the connector-aliased form the announce gate also matches.
    expect(
      findMissingReplyContract(
        [step({
          stepId: 's1',
          toolName: 'slack-d77db9a0__send_message',
          onSuccess: '',
          expectedOutput: 'the summary',
        } as Partial<WorkflowStep> & { stepId: string })],
        MANUAL,
      ),
    ).toEqual([]);
  });

  it('treats an unknown or absent trigger as having a reader', () => {
    // Guessing the other way would silently exempt the exact graphs this exists
    // for whenever the type is missing or newly added.
    expect(
      findMissingReplyContract(
        [step({ stepId: 's1', toolName: 'github__create_review', onSuccess: '', expectedOutput: 'x' } as Partial<WorkflowStep> & { stepId: string })],
        undefined,
      ),
    ).toHaveLength(1);
    expect(
      findMissingReplyContract(
        [step({ stepId: 's1', toolName: 'github__create_review', onSuccess: '', expectedOutput: 'x' } as Partial<WorkflowStep> & { stepId: string })],
        { type: 'something_new' },
      ),
    ).toHaveLength(1);
  });

  it('still requires a declaration on a cron graph', () => {
    // The producer rule is conditional. The declaration is not.
    expect(
      findMissingReplyContract([step({ stepId: 's1', toolName: 'linear__create_ticket', onSuccess: '' })], CRON),
    ).toHaveLength(1);
  });
});
