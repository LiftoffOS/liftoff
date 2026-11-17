// A cron fire carries no `input`, and that is knowable before it runs.
//
// `scheduled-invoke-handler` posts an objective and a companion label. It never
// passes `inputData`. So `{{input.<anything>}}` resolves to undefined on every
// cron run.
//
// Lumping cron in with manual as "carries whatever its caller passed, leave it
// unchecked" is true of manual — an API caller can pass any object — and false
// of cron. That difference is the whole defect: a graph that reads
// `{{input.message.threadId}}`, correct for the `event` trigger it was written
// for, can have companion CRONS running the same graph. Every companion fire
// then fails step 1, takes the escalation branch, and marks mail read without
// ever opening the mailbox — while the pre-flight audit reports the agent
// runnable.

import { validateWorkflowGraph } from '../validate-workflow-graph';
import { applyTemplate } from '../template';
import { TemplateResolutionError } from '../template';
import type { WorkflowStep } from '../types';

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ description: 'd', ...o } as WorkflowStep);

describe('a cron run cannot address {{input.*}}', () => {
  const inboxShapedStep = step({
    stepId: 's1',
    type: 'tool_call',
    toolName: 'gmail-abc__get_thread',
    toolInputTemplate: '{"thread_id":"{{input.message.threadId}}"}',
  });

  it('rejects an event-input step under a cron contract', () => {
    const errors = validateWorkflowGraph([inboxShapedStep], undefined, { triggerType: 'cron' });
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
  });

  it('accepts the same step under the event contract it was written for', () => {
    const errors = validateWorkflowGraph([inboxShapedStep], undefined, {
      triggerType: 'event',
      eventSources: ['google_mail'],
    });
    expect(errors.map((e) => e.code)).not.toContain('UNKNOWN_INPUT_FIELD');
  });

  it('still leaves manual runs unchecked, because a caller can pass anything', () => {
    // The distinction that matters: manual input is genuinely unknowable to a
    // static check, cron input is knowably absent. Collapsing them either
    // rejects valid manual workflows or admits broken cron ones.
    const errors = validateWorkflowGraph([inboxShapedStep], undefined, { triggerType: 'manual' });
    expect(errors.map((e) => e.code)).not.toContain('UNKNOWN_INPUT_FIELD');
  });
});

describe('the runtime agrees with the validator', () => {
  it('throws rather than substituting when the run carries no input', () => {
    // The two must not disagree: a graph the validator accepts must expand, and
    // one it rejects must fail loudly rather than render a placeholder into a
    // vendor argument.
    expect(() => applyTemplate(
      { stepId: 's1', description: 'd', toolInputTemplate: '{"thread_id":"{{input.message.threadId}}"}' } as WorkflowStep,
      { input: undefined, output: undefined, steps: undefined },
    )).toThrow(TemplateResolutionError);
  });

  it('says the root is empty on THIS run, not that it is unreadable', () => {
    // The first version of this message read: `references the root "input",
    // which this run does not carry. Readable roots: input, output, steps.` It
    // named `input` as both missing and available — the one thing the reader
    // needs it to disambiguate.
    let message = '';
    try {
      applyTemplate(
        { stepId: 's1', description: 'd', toolInputTemplate: '{"id":"{{input.message.threadId}}"}' } as WorkflowStep,
        { input: undefined, output: { a: 1 }, steps: undefined },
      );
    } catch (e) { message = (e as Error).message; }

    expect(message).toContain('empty on this run');
    expect(message).toContain('trigger payload');
    // Only roots actually carrying data are offered as alternatives.
    expect(message).toMatch(/Roots carrying data here: output/);
    expect(message).not.toMatch(/Roots carrying data here:[^.]*input/);
  });

  it('leaves an unrecognised root verbatim, which the dispatch guard then catches', () => {
    // TEMPLATE_VAR_RE matches only input/output/steps/item, so `{{nowhere.x}}`
    // is not substituted and not thrown on — it renders into the arguments as
    // literal text. That is precisely the case the substituter cannot cover and
    // the unsubstituted-template guard exists for, so the two together leave no
    // gap: resolvable roots throw here, everything else is refused at dispatch.
    const rendered = applyTemplate(
      { stepId: 's1', description: 'd', toolInputTemplate: '{"x":"{{nowhere.field}}"}' } as WorkflowStep,
      { input: { a: 1 }, output: undefined, steps: undefined },
    );
    expect(JSON.stringify(rendered)).toContain('{{nowhere.field}}');

    const { findUnsubstitutedTemplates } = require('../unsubstituted-template-guard');
    expect(findUnsubstitutedTemplates(rendered)).toHaveLength(1);
  });
});

// A fan-out run is judged by the EVENT contract, not the bare-cron one.
//
// The two halves of the companion fan-out can contradict each other.
// `workSource` resolves the routine's items and runs the graph once per item
// with `input.message` built by the same function the event trigger uses — so
// the run genuinely carries those fields. If graph validation classifies it by
// `triggeredBy === 'cron'`, it rejects every `{{input.message.*}}` reference
// before step 1.
//
// Every fire of such a routine then dies with
// "[UNKNOWN_INPUT_FIELD] {{input.message.threadId}} … a cron fire carries no
// input at all" — a rule that is right about bare crons and wrong about this
// one. The rule stays; the run says which it is.
describe('the fan-out and the validator agree', () => {
  const service = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;
  const handler = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'handlers', 'scheduled-invoke-handler.ts'), 'utf8',
  ) as string;

  // Anchored on the declaration and its ONE consumer, rather than on whatever
  // happens to sit after it. The end anchor was the D20 hash-check marker until
  // the two step-REWRITE passes were lifted out of the `if (!resumeState)` block
  // so they run on resume too; that put the hash check ahead of this
  // declaration, the slice inverted, and both assertions silently ran against
  // an empty string. A ratchet that can pass on "" is not a ratchet.
  function inputContractBlock(): string {
    const from = service.indexOf('const inputContract: WorkflowInputContract');
    const to = service.indexOf('const validationErrors = validateWorkflowGraph(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return service.slice(from, to);
  }

  it('an inputSource run is validated as an event run', () => {
    const block = inputContractBlock();
    expect(block).toMatch(/state\.context\.inputSource/);
    expect(block).toMatch(/triggerType: 'event', eventSources: \[state\.context\.inputSource\]/);
  });

  it('a bare cron with no inputSource is still judged a cron', () => {
    // The original rule is load-bearing: a cron fire really does carry no
    // input, and that is what caught this agent's graph in the first place.
    const block = inputContractBlock();
    expect(block).toMatch(/triggeredBy === 'cron' \? 'cron' : 'manual'/);
  });

  it('the fan-out sets inputSource whenever it supplies inputData', () => {
    // If it set one without the other the halves would disagree again, in the
    // opposite direction.
    expect(handler).toMatch(/inputData && workSource\?\.source \? \{ inputSource: workSource\.source \}/);
  });
});
