// The recovery prompt must survive a long authored instruction.
//
// A step description is bounded at write time at 10,000 characters
// (platform-backend `internal-agents/workflow-step-limits.ts`), and the runtime
// no longer shortens it — a step's objective IS its prompt. The recovery prompt
// used to interpolate the whole steps array through `truncateForPrompt(steps,
// 4096)`, so one ambitious step could exceed the entire plan view: the array
// blew the byte cap, the shape-preserving shrink cut every string to 200
// characters, and if that still did not fit the result was sliced positionally
// — dropping the tail of the workflow outright. The recovery LLM then decided
// what to do next while unable to see steps that exist.
//
// The fix separates the two jobs the prompt was conflating. The plan view says
// what the workflow IS (ids, kinds, tools, short labels) and is bounded by
// construction: at most 50 steps × a fixed label. The step being recovered is
// rendered separately and verbatim, because that is the text the model must act
// on.

import { buildRecoveryPrompt } from '../engine/recovery-prompts';
import type { AnomalyContext, WorkflowStep } from '../types';

/** The write-time maximum for a step description. A description at this length
 *  is legal, storable, and reaches the step prompt in full, so it must reach the
 *  recovery prompt in full too. */
const MAX_AUTHORED_DESCRIPTION = 10_000;

function makeStep(stepId: string, description: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return { stepId, description, type: 'tool_call', ...extra };
}

describe('buildRecoveryPrompt — plan view vs the step being recovered', () => {
  it('carries the recovered step\'s full instruction even at the write-time maximum', () => {
    // The distinctive tail is what a positional slice or a 200-char shrink
    // destroys, and it is exactly where an instruction puts its acceptance
    // criteria ("...then append only rows whose campaign id is not already
    // present").
    const head = 'Read the sheet and decide which campaigns are new. ';
    const tail = ' FINALLY: append only rows whose campaign id is absent.';
    const description =
      head + 'x'.repeat(MAX_AUTHORED_DESCRIPTION - head.length - tail.length) + tail;
    expect(description).toHaveLength(MAX_AUTHORED_DESCRIPTION);

    const step = makeStep('s1', description, { type: 'llm_reason' });
    const anomaly: AnomalyContext = { kind: 'llm_reason_failure', step, error: 'overloaded' };

    const prompt = buildRecoveryPrompt(anomaly, [step], undefined, 's1', [], 0, 0);

    expect(prompt).toContain(head);
    expect(prompt).toContain(tail);
    expect(prompt).toContain(description);
  });

  it('lists every step id when the workflow is at its maximum size with maximal descriptions', () => {
    // 50 steps (the array cap) each at the description cap is 500,000
    // characters of authored text. The plan view must still name all 50, since
    // the model chooses `nextStepId` from this list.
    const steps = Array.from({ length: 50 }, (_, i) =>
      makeStep(`step-${i + 1}`, `Objective ${i + 1}. ${'y'.repeat(MAX_AUTHORED_DESCRIPTION - 20)}`),
    );
    const anomaly: AnomalyContext = { kind: 'tool_error', step: steps[10], error: 'boom' };

    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 'step-11', [], 0, 0);

    for (const step of steps) {
      expect(prompt).toContain(step.stepId);
    }
    // And each step is recognisable, not just named: the label carries the
    // opening of its objective.
    expect(prompt).toContain('Objective 1.');
    expect(prompt).toContain('Objective 50.');
  });

  it('bounds the plan view by construction rather than by a byte cap on the array', () => {
    // Deterministic ceiling: 50 lines of (id + kind + tool + fixed label). The
    // old byte cap produced a prompt whose CONTENT depended on how long the
    // descriptions happened to be; this one does not.
    const steps = Array.from({ length: 50 }, (_, i) =>
      makeStep(`step-${i + 1}`, 'z'.repeat(MAX_AUTHORED_DESCRIPTION), {
        toolName: 'google_sheets__append_row',
      }),
    );
    const anomaly: AnomalyContext = { kind: 'tool_error', step: steps[0], error: 'boom' };

    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 'step-1', [], 0, 0);
    const planView = prompt.slice(
      prompt.indexOf('# The workflow you\'re executing'),
      prompt.indexOf('# The step you\'re recovering'),
    );

    // 50 steps' worth of labels and metadata, plus the recovered step in full.
    // Well under the old 4,096 for the plan portion, and the whole prompt is
    // dominated by the one instruction the model actually needs.
    expect(planView.length).toBeLessThan(20_000);
    expect(planView).not.toContain('z'.repeat(1_000));
  });

  it('marks which step in the plan is the one that failed', () => {
    const steps = [
      makeStep('fetch', 'Fetch the campaign feed'),
      makeStep('append', 'Append new rows to the sheet'),
    ];
    const anomaly: AnomalyContext = { kind: 'tool_error', step: steps[1], error: 'boom' };

    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 'append', [], 0, 0);
    const appendLine = prompt.split('\n').find(l => l.includes('append') && l.includes('2.'));

    expect(appendLine).toBeDefined();
    expect(appendLine).toMatch(/current/i);
  });

  it('records each step\'s kind and tool so the model can reason about the shape', () => {
    const steps = [
      makeStep('fetch', 'Fetch the feed', { toolName: 'http__get' }),
      makeStep('decide', 'Decide what is new', { type: 'llm_reason' }),
      makeStep('ask', 'Ask which tab to use', { type: 'ask_user' }),
    ];
    const anomaly: AnomalyContext = { kind: 'tool_error', step: steps[0], error: 'boom' };

    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 'fetch', [], 0, 0);

    expect(prompt).toContain('http__get');
    expect(prompt).toContain('llm_reason');
    expect(prompt).toContain('ask_user');
  });

  it('never routes the steps array through truncateForPrompt', () => {
    // The regression guard. Any byte cap over the array reintroduces the
    // failure where one long description hides the rest of the workflow.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'engine', 'recovery-prompts.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/truncateForPrompt\(\s*workflowSteps/);
    expect(source).not.toMatch(/truncateForPrompt\(\s*\w*[sS]tep\.description/);
  });

  it('still renders a usable prompt when the workflow has no steps', () => {
    // Chat-mode and single-step recoveries pass an empty array; the recovered
    // step still comes from the anomaly.
    const step = makeStep('only', 'Do the thing');
    const anomaly: AnomalyContext = { kind: 'timeout', step, elapsedMs: 30_000 };

    const prompt = buildRecoveryPrompt(anomaly, [], undefined, 'only', [], 0, 0);

    expect(prompt).toContain('Do the thing');
    expect(prompt).toContain('recovery_decision');
  });

  it('still bounds the genuinely unbounded values', () => {
    // stepOutput arrives from tools with no size contract. Removing its bound
    // is not part of this fix.
    const big = { rows: Array.from({ length: 5_000 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) })) };
    const step = makeStep('s1', 'Fetch report');
    const prompt = buildRecoveryPrompt({ kind: 'tool_error', step, error: 'e' }, [step], big, 's1', [], 1, 1);

    expect(prompt).toMatch(/truncated/);
    expect(prompt.length).toBeLessThan(40_000);
  });
});
