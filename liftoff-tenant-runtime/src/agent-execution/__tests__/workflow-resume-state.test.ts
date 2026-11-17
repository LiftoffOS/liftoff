// What a resumed workflow run carries across the pause.
//
// The cursor was never the whole state. `stepOutputs` — the registry every
// `$.steps.<id>.<field>` reference reads — was rebuilt EMPTY on every entry
// into the loop, and a resume seeded only the cursor. So the second half of a
// workflow ran with the first half's data nowhere in scope, and said nothing
// about it: the references resolved to undefined and surfaced as ordinary tool
// errors.
//
// Take a run continued at s9, where s9 reads steps.s6 and s12 reads steps.s6
// and steps.s8, all produced before the pause. Right after resuming, s9 fails
// with "Cannot read properties of undefined"; later steps follow; the recovery
// advisor spends minutes trying to correct a data problem no correction can
// reach, then escalates. The data had been gathered and is simply
// unreachable.

import { readFileSync } from 'fs';
import { join } from 'path';
import { unresolvableBackReferences, carriedLoopState, gatedStepOutputFromApproval } from '../service';
import type { WorkflowStep, ToolCallResult } from '../types';

const step = (stepId: string, extra: Record<string, unknown> = {}): WorkflowStep =>
  ({ stepId, type: 'llm_reason', ...extra }) as unknown as WorkflowStep;

describe('a resume that cannot resolve its own data', () => {
  // s6 and s8 ran before the cursor; s9 onward read them.
  const graph = [
    step('s6'),
    step('s7'),
    step('s8'),
    step('s9', { prompt: 'compare against {{steps.s6.prior}}' }),
    step('s10', { prompt: 'summarise {{steps.s9.diff}}' }),
    step('s12', { toolInputTemplate: { a: '{{steps.s6.prior}}', b: '{{steps.s8.capture}}' } }),
  ];

  it('names every earlier step the rest of the graph reads and cannot get', () => {
    expect(unresolvableBackReferences({ steps: graph, cursorStepId: 's9', registry: {} }))
      .toEqual(['s6', 's8']);
  });

  it('is satisfied once the registry carries them', () => {
    expect(unresolvableBackReferences({
      steps: graph, cursorStepId: 's9', registry: { s6: { prior: [] }, s8: { capture: [] } },
    })).toEqual([]);
  });

  it('accepts a registry entry whose value is null or empty', () => {
    // "Produced nothing" is a real answer and a different thing from "absent".
    expect(unresolvableBackReferences({
      steps: graph, cursorStepId: 's9', registry: { s6: null, s8: undefined },
    })).toEqual([]);
  });

  it('ignores a FORWARD reference, which is ordinary', () => {
    // s10 reads s9, which has not run yet at the cursor. Normal.
    expect(unresolvableBackReferences({ steps: graph, cursorStepId: 's6', registry: {} }))
      .toEqual([]);
  });

  it('says nothing about a cursor that is not in the graph', () => {
    expect(unresolvableBackReferences({ steps: graph, cursorStepId: 'nope', registry: {} }))
      .toEqual([]);
  });

  it('reads references wherever they appear in a step', () => {
    // Templates, prompts, conditions and validators all carry them, which is
    // why this reads the serialized step rather than one known field.
    const g = [step('a'), step('b', { condition: '$.steps.a.ok == true' })];
    expect(unresolvableBackReferences({ steps: g, cursorStepId: 'b', registry: {} }))
      .toEqual(['a']);
  });
});

describe('what a pause carries', () => {
  it('snapshots all eight parts, with sets flattened for JSON', () => {
    const carried = carriedLoopState({
      stepOutputs: { s1: { x: 1 } },
      enteredSteps: new Set(['s1', 's2']),
      unsatisfiedSteps: new Set(['s2']),
      salvagedSteps: new Set(['s1']),
      salvageNotes: { s1: { unavailable: [{ name: 'web_fetch_advanced', args: '{"url":"https://x"}' }], interruptedBy: 'anomaly_escalated' } },
      perStepRecoveries: { s2: 1 },
      totalRecoveries: 1,
      recoveryHistory: [{ stepId: 's2', anomalyKind: 'tool_error', decision: 'continue', kind: 'fresh' }],
    });
    expect(carried.stepOutputs).toEqual({ s1: { x: 1 } });
    expect(carried.enteredSteps).toEqual(['s1', 's2']);
    expect(carried.unsatisfiedSteps).toEqual(['s2']);
    expect(carried.salvagedSteps).toEqual(['s1']);
    expect(carried.salvageNotes).toEqual({ s1: { unavailable: [{ name: 'web_fetch_advanced', args: '{"url":"https://x"}' }], interruptedBy: 'anomaly_escalated' } });
    expect(carried.perStepRecoveries).toEqual({ s2: 1 });
    expect(carried.totalRecoveries).toBe(1);
    expect(carried.recoveryHistory).toHaveLength(1);
    // Survives the round trip it is stored through.
    expect(JSON.parse(JSON.stringify(carried)).enteredSteps).toEqual(['s1', 's2']);
    expect(JSON.parse(JSON.stringify(carried)).salvagedSteps).toEqual(['s1']);
  });

  it('copies the registry rather than aliasing the live one', () => {
    const live = { s1: 1 };
    const carried = carriedLoopState({
      stepOutputs: live, enteredSteps: new Set(), unsatisfiedSteps: new Set(),
      salvagedSteps: new Set(), salvageNotes: {},
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
    });
    (live as Record<string, unknown>).s2 = 2;
    expect(carried.stepOutputs).toEqual({ s1: 1 });
  });
});

describe('every pause site carries it, by construction', () => {
  const service = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
  const loop = service.slice(
    service.indexOf('  private async runAgentHybridLoop('),
    service.indexOf('  private async dispatchRecoveryDecision('),
  );

  it('seeds the registry from the pause instead of rebuilding it empty', () => {
    expect(loop).toContain('{ ...(resumeState?.stepOutputs ?? {}) }');
    expect(loop).toContain('new Set<string>(resumeState?.enteredSteps ?? [])');
    expect(loop).toContain('new Set<string>(resumeState?.unsatisfiedSteps ?? [])');
  });

  it('spreads the same snapshot at EVERY pause in the loop', () => {
    // The rule this enforces: a site that carries three of the six resumes a
    // run with half its state, and the missing half is invisible until a later
    // step reads it.
    const sites = [...loop.matchAll(/kind: 'hybrid-pause'/g)];
    expect(sites.length).toBeGreaterThan(0);
    for (const m of sites) {
      expect(loop.slice(m.index!, m.index! + 700)).toContain('...carried()');
    }
  });

  it('hands the live state down to anything that may pause on the loop\'s behalf', () => {
    for (const m of loop.matchAll(/this\.runRecoveryCycle\(\{/g)) {
      const call = loop.slice(m.index!, loop.indexOf('});', m.index!));
      expect(call).toContain('...loopState()');
    }
    // And the recovery dispatcher builds its pauses from that same bag.
    const dispatch = service.slice(service.indexOf('  private async dispatchRecoveryDecision('));
    for (const m of dispatch.slice(0, 6000).matchAll(/kind: 'hybrid-pause'/g)) {
      expect(dispatch.slice(m.index!, m.index! + 700)).toContain('carriedLoopState(counters)');
    }
  });

  it('refuses a resume it cannot resolve, before running a step', () => {
    expect(loop).toContain('unresolvableBackReferences(');
    expect(loop.indexOf('unresolvableBackReferences(')).toBeLessThan(loop.indexOf('while (currentStepId)'));
  });
});

describe('a delay carries its state on the row, not in the task', () => {
  const handler = readFileSync(join(__dirname, '..', 'handlers', 'delay-step-handler.ts'), 'utf8');
  const tasks = readFileSync(join(__dirname, '..', '..', 'handlers', 'cloud-tasks-handler.ts'), 'utf8');

  it('persists the payload on the scheduled row', () => {
    // A Cloud Task body is capped at 100KB; the registry holds the gathered
    // data itself.
    expect(handler).toContain("kind: 'workflow-delay'");
    expect(handler).toMatch(/workflowResume: \{[\s\S]{0,400}\.\.\.\(input\.carried \?\? \{\}\)/);
  });

  it('keeps the big field out of the task body', () => {
    const body = handler.slice(handler.indexOf('receiverBody:'));
    expect(body.slice(0, 400)).not.toContain('stepOutput: input.stepOutput');
  });

  it('reads the row first and falls back to the body', () => {
    const branch = tasks.slice(tasks.indexOf("// Default ('delay')"));
    expect(branch.slice(0, 2500)).toContain('workflowResumePayload');
    expect(branch.slice(0, 2500)).toMatch(/fromRow \? fromRow\.stepOutput : workflowResume\.stepOutput/);
  });

  it('does not start posting delayed follow-ups into a chat thread', () => {
    // Carrying state and speaking to a person are different things. A delay is
    // a wait the workflow chose; nobody is sitting in a thread waiting for it.
    const branch = tasks.slice(tasks.indexOf("// Default ('delay')"));
    const upToResume = branch.slice(0, branch.indexOf('recordResume('));
    expect(upToResume).toContain('carryOver:');
    expect(upToResume).not.toContain('deliverTo:');
  });
});

describe('the step that just finished is registered before anything can end the run', () => {
  // The park sits at the loop head, and the registry entry for the PREVIOUS
  // step was written just below it. So a run that parked snapshotted a registry
  // missing the step that had completed one instant earlier -- which is exactly
  // the step the next one reads.
  //
  // A run parked at s9 with s8 finished and unregistered cannot resume, because
  // the rest of the graph reads s8. The guard catches it; the ordering is what
  // causes it.
  const service = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
  const loop = service.slice(service.indexOf('    while (currentStepId) {'));
  const head = loop.slice(0, 4000);

  it('registers the completed output above the ceilings, not below them', () => {
    expect(head.indexOf('stepOutputs[previousStepId] = stepOutput'))
      .toBeLessThan(head.indexOf('wallClockStart > maxWallClockMs'));
  });

  it('still advances the cursor bookkeeping after the ceilings', () => {
    // previousStepId and enteredSteps describe the step ABOUT to run, so they
    // must not move for a step a ceiling stops from ever running.
    expect(head.indexOf('wallClockStart > maxWallClockMs'))
      .toBeLessThan(head.indexOf('previousStepId = currentStepId'));
    expect(head.indexOf('wallClockStart > maxWallClockMs'))
      .toBeLessThan(head.indexOf('enteredSteps.add(currentStepId)'));
  });

  it('still withholds an entry for a step that produced nothing', () => {
    expect(head).toContain('!unsatisfiedSteps.has(previousStepId)');
  });
});

describe('the ExecutionState a resume runs on is complete', () => {
  // The defect that actually stopped the report, and the subtlest of the set.
  //
  // resumeWorkflow built its state as `{ context, toolCallsExecuted,
  // reasoningSteps } as ExecutionState`. Seven required fields were missing and
  // the cast is the only reason it compiled. `invokeStepLLM` reads
  // `state.steps.length` before invoking the model, so the FIRST llm_reason
  // step after ANY resume threw "Cannot read properties of undefined (reading
  // 'length')" -- which surfaced as a generic tool error, and the recovery
  // advisor spent minutes trying to correct a data problem that was really an
  // uninitialised object.
  //
  // Pre-existing for every delay resume; the wall-clock continuation made
  // resuming routine and turned it into the normal path.
  const service = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

  it('constructs the state without a cast, so the compiler checks it', () => {
    const fn = service.slice(service.indexOf('  async resumeWorkflow(input: {'));
    const decl = fn.slice(fn.indexOf('const state: ExecutionState'));
    const body = decl.slice(0, decl.indexOf('};') + 2);
    expect(body).not.toContain('as ExecutionState');
    for (const field of [
      'startTime', 'steps', 'conversationHistory', 'pendingToolCalls',
      'completedToolCalls', 'toolFailureCounts', 'injectedSkillIds',
    ]) {
      expect(body).toContain(field);
    }
  });

  it('leaves no cast anywhere that could hide the same drift', () => {
    // A cast on this type defeats the only check that catches a field being
    // added to ExecutionState and missed at one construction site.
    expect(service.split('as ExecutionState').length - 1).toBeLessThanOrEqual(1);
  });
});

// The output a gated step contributes on resume, from the tool calls a person
// approved. This is what lets the resume COMPLETE the gated step instead of
// re-running it (which would re-issue the just-approved outbound call).
describe('gatedStepOutputFromApproval', () => {
  const gated = (extra: Record<string, unknown> = {}): WorkflowStep =>
    ({ stepId: 'g', type: 'tool_call', ...extra }) as unknown as WorkflowStep;
  const ok = (result: unknown): ToolCallResult => ({ id: 'pc1', success: true, result });

  it('no outputField → the raw approved result IS the step output', () => {
    const out = gatedStepOutputFromApproval(gated(), [ok({ messageId: 'm1', status: 'sent' })]);
    expect(out).toEqual({ output: { messageId: 'm1', status: 'sent' } });
  });

  it('outputField present → narrows to that field, exactly as executeToolStep does', () => {
    const out = gatedStepOutputFromApproval(gated({ outputField: 'messageId' }), [ok({ messageId: 'm1' })]);
    expect(out).toEqual({ output: 'm1' });
  });

  it('outputField absent from the result → failed contract, returns the named error (not a wrong-shaped value)', () => {
    const out = gatedStepOutputFromApproval(gated({ outputField: 'messageId' }), [ok({ other: 1 })]);
    expect('error' in out).toBe(true);
    if ('error' in out) {
      expect(out.error.name).toBe('OutputShapeMismatchError');
      expect(out.error.message).toContain('messageId');
    }
  });

  it('any failed call among the approved set is a step failure — a failed sibling is not dropped', () => {
    // A person approved EVERY one of these calls; picking the first success and
    // ignoring the failed one advances onSuccess as if nothing failed. Approval
    // authorises an attempt, not a result, so any failure fails the step.
    const results: ToolCallResult[] = [
      { id: 'a', success: false, error: 'rate limited', errorCode: 'RATE_LIMITED' as ToolCallResult['errorCode'], retryable: true },
      { id: 'b', success: true, result: { messageId: 'm2' } },
    ];
    const out = gatedStepOutputFromApproval(gated({ outputField: 'messageId' }), results);
    expect('failure' in out).toBe(true);
    if ('failure' in out) {
      expect(out.failure.message).toContain('rate limited');
      expect(out.failure.errorCode).toBe('RATE_LIMITED');
      expect(out.failure.retryable).toBe(true);
    }
  });

  it('a single failed approved call is a failure, not a success-shaped output', () => {
    const out = gatedStepOutputFromApproval(gated(), [{ id: 'pc1', success: false, error: 'SMTP 550' }]);
    expect('failure' in out).toBe(true);
    if ('failure' in out) expect(out.failure.message).toContain('SMTP 550');
  });

  it('an empty approved set is a failure, never an empty success', () => {
    const out = gatedStepOutputFromApproval(gated(), []);
    expect('failure' in out).toBe(true);
  });
});
