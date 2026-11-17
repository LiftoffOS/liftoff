// A conditional step with no else-edge silently ends the run.
//
// `onFailure` is the ELSE branch of a `condition`, not only the error handler.
// The executor evaluates the predicate and, when it does not hold, sets
// `currentStepId = step.onFailure || ''` — and an empty string ends the loop.
// The run falls out of the graph having skipped everything downstream and,
// because nothing failed to produce a declared output, reports success.
//
// Example: `s4` routes to "escalate", "ack-only" or "search-help". `s5` guards
// on `$.steps.s4.next == 'search-help'` and declares no onFailure. So every
// escalate and ack-only decision — Critical urgency, billing, refunds, pricing,
// account security, cancellation, precisely the mail that most needs a human —
// ends the run at s5. No Slack post, no teammate notified, no acknowledgement
// to the customer, not even a mark-as-read, and a green success on the
// invocation. An escalation branch s10 sits unreachable behind the same shape.
//
// Static reachability cannot catch this. s10 HAS an inbound edge (s1's
// onFailure), so the graph is connected. The missing edge is the one for the
// predicate being false, which is a property of the condition, not the graph.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { findConditionsWithoutElse } from '../distill-service';

 
const steps = (rows: Array<Record<string, unknown>>) => rows as any;

describe('the shape that shipped', () => {
  it('rejects the exact s5 that stopped the run', () => {
    const out = findConditionsWithoutElse(steps([
      { stepId: 's4', type: 'llm_reason', outputField: 'routing', onSuccess: 's5' },
      { stepId: 's5', type: 'llm_reason', condition: "$.steps.s4.next == 'search-help'", onSuccess: 's6' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('condition_without_else');
    expect(out[0].stepId).toBe('s5');
  });

  it('says what actually happens, not that a field is missing', () => {
    // "onFailure is required" teaches nothing. The model omitted it because the
    // schema described it as an error handler and it had no error to handle.
    const [err] = findConditionsWithoutElse(steps([
      { stepId: 's5', condition: "$.steps.s4.next == 'search-help'", onSuccess: 's6' },
    ]));
    expect(err.detail).toMatch(/ELSE branch/i);
    expect(err.detail).toMatch(/ENTIRE RUN ENDS/i);
    expect(err.detail).toMatch(/still reports success/i);
  });

  it('flags every offending step, not just the first', () => {
    const out = findConditionsWithoutElse(steps([
      { stepId: 's5', condition: "$.steps.s4.next == 'x'" },
      { stepId: 's6', condition: "$.steps.s5.confidence == 'high'", onFailure: 's8' },
      { stepId: 's10', condition: "$.steps.s4.next == 'escalate'" },
    ]));
    expect(out.map(e => e.stepId)).toEqual(['s5', 's10']);
  });
});

describe('what it must not fire on', () => {
  it('accepts a conditional step that declares its else-edge', () => {
    // s6 was already correct: guarded on high confidence, with onFailure routing
    // the low-confidence case to the Slack escalation.
    expect(findConditionsWithoutElse(steps([
      { stepId: 's6', condition: "$.steps.s5.confidence == 'high'", onSuccess: 's7', onFailure: 's8' },
    ]))).toEqual([]);
  });

  it('leaves unconditional steps alone', () => {
    // An unconditional step without onFailure is ordinary: there is no predicate
    // that can push the cursor off the graph.
    expect(findConditionsWithoutElse(steps([
      { stepId: 's1', toolName: 'gmail__get_thread', onSuccess: 's2' },
      { stepId: 's2', toolName: 'gmail__list_messages', onSuccess: 's3', onFailure: 's3' },
    ]))).toEqual([]);
  });

  it('accepts an empty graph', () => {
    expect(findConditionsWithoutElse(steps([]))).toEqual([]);
  });
});

describe('the schema tells the model this before it authors', () => {
  // The validator is the backstop. The reason s5 was written that way is that
  // the schema called onFailure a failure handler and said nothing about
  // conditions, so a step with a predicate and no error had no reason to set it.
  const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

  it('describes onFailure as the else branch of a condition', () => {
    const onFailureDesc = SRC.slice(
      SRC.indexOf("onFailure: { type: 'string', description:"),
      SRC.indexOf("requiresApproval: { type: 'boolean' }"),
    );
    expect(onFailureDesc).toMatch(/ELSE BRANCH/i);
    expect(onFailureDesc).toMatch(/ENTIRE RUN ENDS/i);
    expect(onFailureDesc).toMatch(/not rely on falling through to onSuccess/i);
  });

  it('warns on the condition field that a missing else-edge ends the run', () => {
    const conditionDesc = SRC.slice(
      SRC.indexOf('Optional gate on this step.'),
      SRC.indexOf('Optional gate on this step.') + 2400,
    );
    expect(conditionDesc).toMatch(/A CONDITION WITHOUT `onFailure` ENDS THE RUN/);
    expect(conditionDesc).toMatch(/no fall-through to onSuccess/i);
    // The second half of the defect: a branch nothing routes to is dead.
    expect(conditionDesc).toMatch(/is dead/i);
  });
});
