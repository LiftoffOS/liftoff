// The recovery advisor writes to a customer, and for a long time nothing in
// its prompt said so.
//
// Three of the fields it returns are rendered on the review page word for word:
// `userQuestion` on its own, and `requestedAction` + `escalationReason`
// concatenated by blockerTextFor when a run parks. The call site described the
// whole call as "not customer-visible work", and on that belief the advisor
// became the one model call in the runtime carrying no voice rules at all —
// while chat, autonomous runs, Liftoff and Insights all carry them.
//
// What shipped as a result: a question asking someone to reconnect an account,
// citing a raw credential id, an HTTP status, a vendor exception class name and
// an em dash. Not because the rules did not exist, but because that call never
// received them.

import { buildRecoveryPrompt } from '../engine/recovery-prompts';
import { AGENT_VOICE_BLOCK } from '../../interactive-chat/agent-voice';
import type { AnomalyContext, WorkflowStep } from '../types';

const step: WorkflowStep = {
  stepId: 's1',
  description: 'Open a pull request against the release branch',
  type: 'tool_call',
} as WorkflowStep;

const anomaly = {
  kind: 'tool_error',
  step,
  error: 'HTTP 404 ConnectedAccount_ResourceNotFound',
} as AnomalyContext;

const prompt = () => buildRecoveryPrompt(anomaly, [step], undefined, 's1', [], 0, 0);

describe('the recovery advisor is told a person reads it', () => {
  it('carries the canonical voice block, like every other customer-facing surface', () => {
    // The shared text, not a paraphrase of it. A local restatement is how the
    // rules drifted apart across surfaces before it was centralised.
    expect(prompt()).toContain(AGENT_VOICE_BLOCK);
  });

  it('names the three fields a customer reads', () => {
    const p = prompt();
    for (const field of ['userQuestion', 'requestedAction', 'escalationReason']) {
      expect(p).toContain(field);
    }
    expect(p).toContain('Who reads what you write');
  });

  it('rules out the specific things that leaked', () => {
    const p = prompt();
    expect(p).toMatch(/internal identifiers/i);
    expect(p).toMatch(/status codes/i);
    expect(p).toMatch(/exception class names/i);
  });

  // Inherited from the voice block rather than restated here: if the block ever
  // stops carrying these, this advisor silently stops carrying them too, and
  // that is worth failing over.
  it('inherits the terminology and punctuation rules through the block', () => {
    const p = prompt();
    expect(p).toMatch(/never "AI team"/i);
    expect(p).toMatch(/Never use an em dash/i);
  });

  it('still says what the tool is for, so the rules did not displace the task', () => {
    const p = prompt();
    expect(p).toContain('recovery_decision');
    expect(p).toContain('whoCanUnblock');
  });

  // The reason is also the RECORD when the run ends rather than parks. An
  // advisor handed three "internal error" texts for three guessed addresses
  // wrote that the web fetching service could not retrieve any of the target
  // URLs, beside thirty pages the same step had fetched: it described a
  // platform it had not observed.
  it('tells the advisor to state only what the tool results showed', () => {
    const p = prompt();
    expect(p).toContain('In escalationReason, state only what the tool results showed.');
    expect(p).toMatch(/Do not describe\s+platform state you did not observe/);
  });
});
