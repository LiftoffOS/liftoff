// Unit tests for the recovery prompt builder (pure module, D13).
//
// Verifies: prompt structure, anomaly snippet routing, truncation budgets,
// no-recovery-history vs with-history branching.

import { buildRecoveryPrompt } from '../engine/recovery-prompts';
import type { AnomalyContext, WorkflowStep } from '../types';

const step: WorkflowStep = {
  stepId: 's1',
  description: 'Fetch report',
  toolName: 'reports__fetch',
  type: 'tool_call',
};

const steps: WorkflowStep[] = [step];

describe('buildRecoveryPrompt', () => {
  it('includes the step id, output, attempt counts, and decision menu', () => {
    const anomaly: AnomalyContext = { kind: 'tool_error', step, error: 'boom' };
    const prompt = buildRecoveryPrompt(anomaly, steps, { id: 42 }, 's1', [], 1, 1);
    expect(prompt).toContain('s1');
    expect(prompt).toContain('boom');
    expect(prompt).toContain('Number of recovery attempts so far on this step: 1');
    expect(prompt).toContain('Total recovery attempts this run: 1');
    // The decision is now recorded through a tool call, not prose the parser
    // has to pattern-match — the prompt has to say so, or the model answers in
    // a shape nothing reads.
    expect(prompt).toContain('recovery_decision');
    expect(prompt).toContain('Set `decision` to one of:');
    expect(prompt).toContain('ask_user');
  });

  it('switches the recovery-history line when priorRecoveries is non-empty', () => {
    const prompt = buildRecoveryPrompt(
      { kind: 'tool_error', step, error: 'e' },
      steps,
      {},
      's1',
      [{ stepId: 's1', anomalyKind: 'tool_error', decision: 'continue', kind: 'fresh' }],
      1,
      1,
    );
    expect(prompt).toContain('Recent recovery history');
    expect(prompt).toContain('escalating with a meaningful message');
  });

  it('renders user_answered_clarification with original question and answer', () => {
    const anomaly: AnomalyContext = {
      kind: 'user_answered_clarification',
      step,
      originalQuestion: 'Which sheet?',
      userAnswer: 'Sheet1',
    };
    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 's1', [], 0, 0);
    expect(prompt).toContain('Which sheet?');
    expect(prompt).toContain('Sheet1');
  });

  it('renders user_message_during_run with the user message', () => {
    const anomaly: AnomalyContext = {
      kind: 'user_message_during_run',
      step,
      userMessage: 'wait, stop',
    };
    const prompt = buildRecoveryPrompt(anomaly, steps, undefined, 's1', [], 0, 0);
    expect(prompt).toContain('wait, stop');
  });

  // Threads are shared, so the person redirecting a run is not necessarily the
  // person who started it. "Ada asked me to stop" is a different instruction
  // from "someone asked me to stop", and the model can only weigh that if the
  // prompt says who.
  it('names the interrupting person when the signal carried an identity', () => {
    const prompt = buildRecoveryPrompt(
      {
        kind: 'user_message_during_run',
        step,
        userMessage: 'compare it against yesterday first',
        senderDisplayName: 'Ada Lovelace',
        senderAccountId: '00000000-0000-0000-0000-0000000000aa',
      },
      steps, undefined, 's1', [], 0, 0,
    );
    expect(prompt).toContain('Ada Lovelace sent a message');
    expect(prompt).toContain('compare it against yesterday first');
    // The model is told the thread is shared so it does not assume the
    // interrupt came from whoever started the run.
    expect(prompt).toMatch(/shared/i);
  });

  // Signals written before the payload carried identity, and guests with no
  // account, must fall back rather than inventing a sender.
  it('falls back to anonymous wording when no identity was carried', () => {
    const prompt = buildRecoveryPrompt(
      { kind: 'user_message_during_run', step, userMessage: 'stop', senderDisplayName: null },
      steps, undefined, 's1', [], 0, 0,
    );
    expect(prompt).toContain('The user sent a message');
    expect(prompt).not.toMatch(/null/);
  });

  it('truncates very large stepOutput inside the prompt', () => {
    const big = { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) })) };
    const prompt = buildRecoveryPrompt(
      { kind: 'tool_error', step, error: 'e' },
      steps,
      big,
      's1',
      [],
      1,
      1,
    );
    // Truncation marker must be present for at least one bounded field.
    expect(
      prompt.includes('truncated') ||
        prompt.includes('more items truncated') ||
        prompt.includes('more keys truncated'),
    ).toBe(true);
  });
});
