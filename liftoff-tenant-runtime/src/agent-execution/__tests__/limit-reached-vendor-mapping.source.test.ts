// Each vendor's ceiling maps to the shared ending, at its own adapter edge.
//
// We run six engines behind one contract. Solving this for Anthropic alone
// would leave the same defect live on every other provider — and Gemini's was
// the inverse and worse: MAX_TOKENS sat in NORMAL_FINISH_REASONS, so a Gemini
// answer truncated mid-sentence was recorded as a clean success.
//
// Source scan: these adapters pull vendor SDKs and network clients, and the
// property under test is which literal each edge maps to.

import { readFileSync } from 'fs';
import { join } from 'path';
import { iterationBudgetFor, CHILD_ITERATION_BUDGET } from '../delegation-roles';

const A = (...p: string[]) => readFileSync(join(__dirname, '..', 'adapter', ...p), 'utf8');

describe('Anthropic', () => {
  const SRC = A('anthropic', 'index.ts');

  it('maps the SDK ceilings to limit_reached, not error', () => {
    expect(SRC).toMatch(/error_max_turns[\s\S]{0,120}limit_reached/);
    expect(SRC).toContain('error_max_budget_usd');
  });

  it('still calls a genuine execution failure an error', () => {
    // error_during_execution must NOT be swept into the softer ending.
    const m = SRC.match(/subtype === 'success'[\s\S]{0,400}?;/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('error_during_execution');
  });
});

describe('Gemini', () => {
  const SRC = A('gemini', 'index.ts');

  it('no longer counts a truncated answer as a normal stop', () => {
    const normal = SRC.match(/NORMAL_FINISH_REASONS[\s\S]{0,200}?\]\);/);
    expect(normal).not.toBeNull();
    expect(normal![0]).not.toContain('MAX_TOKENS');
  });

  it('reports the output limit as limit_reached', () => {
    expect(SRC).toMatch(/LIMIT_FINISH_REASONS[\s\S]{0,200}MAX_TOKENS/);
    expect(SRC).toMatch(/LIMIT_FINISH_REASONS\.has\(finishReason\)[\s\S]{0,200}limit_reached/);
  });
});

describe('OpenAI', () => {
  const SRC = A('openai-wire', 'index.ts');

  it('recognises the Agents SDK MaxTurnsExceeded rather than routing it to recovery', () => {
    expect(SRC).toMatch(/max turns[\s\S]{0,200}limit_reached/i);
  });
});

describe('the consumers that would otherwise mistake it', () => {
  const SVC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

  it('a delegated child that ran out of room does not return partial work as an answer', () => {
    expect(SVC).toMatch(/limit_reached[\s\S]{0,200}delegateToAgent child reached its limit/);
  });

  it('a workflow step that ran out of room does not feed the next step', () => {
    expect(SVC).toMatch(/limit_reached[\s\S]{0,200}reached its limit before finishing/);
  });

  it('the conversational loop records it instead of falling through to success', () => {
    // The fallback below it assumes a run that stopped talking finished its
    // job. Reaching that branch is what would turn every truncated run into a
    // success — the opposite of the bug, and quieter.
    expect(SVC).toMatch(/event\.outcome === 'limit_reached'[\s\S]{0,800}terminalState: 'limit_reached'/);
  });
});

describe('the breaker', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', 'handlers', 'cloud-tasks-handler.ts'), 'utf8',
  );

  it('does not count a run that hit its ceiling', () => {
    // It says the budget is too small, not that the routine is broken, and
    // pausing the agent is the wrong answer to that.
    expect(SRC).toMatch(/terminalState === 'limit_reached'/);
    // The guard gained a second exclusion — a clean escalation is likewise not
    // evidence about the routine (escalation-is-not-a-routine-failure.test.ts).
    // Asserted on `!hitItsLimit` still gating the record, not on the guard being
    // that condition alone, so adding a third carve-out does not fail this.
    expect(SRC).toMatch(/if \(!hitItsLimit[^)]*\)[\s\S]{0,200}recordRoutineOutcome/);
  });
});

describe('the budget itself', () => {
  // Asserted against iterationBudgetFor's BEHAVIOUR rather than against the
  // source text of its call site.
  //
  // This used to regex service.ts for the identifier `cfgMaxToolCalls` inside
  // the `const maxTurns = iterationBudgetFor(...)` block. That proved the
  // variable was spelled a certain way at a certain place — nothing about what
  // any budget resolves to — so it broke on a rename that changed no behaviour
  // while it would have stayed green through a change that silently re-floored
  // the budget somewhere else. The bug it guards (`Math.min(configured,
  // maxReasoningSteps)` making `maxToolCalls: 200` run as 50) is a fact about
  // the returned number, so assert the number.

  it('is no longer floored against a constant no tenant can raise', () => {
    // The original bug: a configured budget larger than the in-code default
    // silently collapsed to the default.
    expect(iterationBudgetFor('orchestrator', 200)).toBe(200);
  });

  it('gives an orchestrator exactly what the tenant configured', () => {
    expect(iterationBudgetFor('orchestrator', 7)).toBe(7);
    expect(iterationBudgetFor('orchestrator', 500)).toBe(500);
  });

  it('holds a leaf to the child budget when the tenant configured more', () => {
    // A leaf answering one question in fifty turns is not converging.
    expect(iterationBudgetFor('leaf', 200)).toBe(CHILD_ITERATION_BUDGET);
  });

  it('never RAISES a budget to reach the child ceiling', () => {
    // A tenant who configured less than the child budget meant less.
    expect(iterationBudgetFor('leaf', 3)).toBe(3);
  });
});
