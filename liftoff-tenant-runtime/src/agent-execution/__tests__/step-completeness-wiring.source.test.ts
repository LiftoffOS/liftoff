// The completeness constraint survives the hop from tool result to step input.
//
// A result the agent may only act on IN FULL keeps that property when it becomes
// the next step's input: the constraint belongs to the DATA, not to the moment
// of the call. The gateway enforces it at dispatch; nothing carried it across
// the step boundary, so a read whose whole point was completeness arrived at the
// next step as an 8,192-character summary with no way to tell.
//
// Asserted at the source because the alternative is booting the hybrid loop with
// a workflow, an adapter, a catalog and a workspace writer to observe one string
// in one prompt — a test that would break for a dozen reasons unrelated to what
// it checks. Same idiom as the other *.source.test.ts guards here.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The body of invokeStepLLM, by brace matching from its signature. */
function invokeStepLLMBody(): string {
  const start = SRC.indexOf('private async invokeStepLLM(');
  expect(start).toBeGreaterThan(-1);
  // Past the END of the return type: `Promise<{ output: unknown }>` contains
  // braces of its own, and starting the scan at the first `{` after the
  // signature matches those instead of the body.
  const RETURN_TYPE = '): Promise<{ output: unknown }>';
  const open = SRC.indexOf('{', SRC.indexOf(RETURN_TYPE, start) + RETURN_TYPE.length);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  return '';
}

describe('provenance travels with the value', () => {
  it('the loop tracks which tool produced the current step output', () => {
    expect(SRC).toContain('let stepOutputProducedBy: string | undefined;');
  });

  it('it is set from the step that just advanced, and only for a tool call', () => {
    // An llm_reason step's output is the model's own prose and carries no
    // completeness claim to preserve.
    expect(SRC).toMatch(
      /stepOutputProducedBy = step\.type === 'tool_call' \|\| \(!step\.type && step\.toolName\)\s*\n\s*\? step\.toolName\s*\n\s*: undefined;/,
    );
  });

  // Matched on the argument rather than the whole call, so adding a parameter
  // to invokeStepLLM does not read as provenance having been dropped. The
  // property under test is that `stepOutputProducedBy` is threaded, not the
  // arity of a call that legitimately grows — `runObjective` was added beside
  // it so a step can see the request it is acting on.
  it('and reaches invokeStepLLM', () => {
    const call = SRC.match(/this\.invokeStepLLM\(([^)]*)\)/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('stepOutputProducedBy');
    expect(call![1]).toContain('objective');
  });
});

describe('a completeness-required value is never summarised', () => {
  const body = invokeStepLLMBody();

  it('finds the function', () => {
    expect(body).not.toBe('');
  });

  it('decides mustBeWhole from the same policy the gateway enforces', () => {
    // One source of truth for "which tools" — the compiled instruction's
    // resultRules, already on the execution context for the gateway.
    expect(body).toContain('state.context.completeResultRequiredTools');
    expect(body).toContain('const mustBeWhole =');
  });

  it('skips compression entirely for such a value when it parked', () => {
    // Building the summary and then not showing it would still pay an LLM call
    // and still leave the partial one edit away from the prompt.
    expect(body).toMatch(/const priorOutputSummary = mustBeWhole && offloaded\s*\n\s*\? ''/);
  });

  it('fails the step when the value must be whole, did not fit, and did not park', () => {
    // The one case where failing is right: the data is already gone, so
    // continuing means computing a confident wrong answer.
    expect(body).toMatch(/if \(mustBeWhole && priorExceeded && !offloaded\) \{/);
    expect(body).toContain("metric: 'step_output.complete_required_unrecoverable'");
    expect(body).toMatch(/throw new Error\(/);
  });

  it('distinguishes the two causes rather than asserting one', () => {
    // "Too large" sends someone to the budget. But `offloaded` is null for two
    // different reasons — no workspace at all, or a workspace whose write was
    // refused — and naming the wrong one sends the operator to the wrong place.
    // The message branches on which actually holds.
    expect(body).toMatch(/const hasWorkspace = platformCatalog\.writeWorkspaceFile != null;/);
    expect(body).toMatch(/hasWorkspace\s*\n?\s*\?\s*'This agent has a workspace/);
    expect(body).toMatch(/: 'This agent has no workspace to park it in\. '/);
    expect(body).toMatch(/hasWorkspace,/);
  });
});

describe('the prompt says which of the three states this value is in', () => {
  const body = invokeStepLLMBody();

  it('renders through the shared view rather than assembling strings inline', () => {
    expect(body).toContain('renderPriorOutput({');
    // The old inline form silently omitted the truncation case.
    expect(body).not.toMatch(/\$\{offloaded \? offloadNote\(offloaded\) : ''\}/);
  });

  it('passes every fact the three renderings need', () => {
    const call = /renderPriorOutput\(\{[\s\S]*?\}\)/.exec(body)?.[0] ?? '';
    for (const field of ['summary', 'offloaded', 'mustBeWhole', 'exceeded', 'producedBy', 'chars']) {
      // `field: value` or the shorthand `field,` — both are the field being passed.
      const present = new RegExp(`\\b${field}\\s*[,:]`).test(call);
      expect({ field, present }).toEqual({ field, present: true });
    }
  });

  it('measures "exceeded" with the same serializer the summary is built from', () => {
    // NOT the one the offloader uses — it serialises indented and this is
    // compact, so its view is always the larger. The asymmetry is safe only in
    // one direction, and the code says which; this pins the serializer so the
    // reasoning stays checkable rather than becoming folklore.
    expect(body).toContain('const priorSerialized = serializeForPrompt(stepOutput);');
    expect(body).toContain('priorSerialized.length > STEP_OUTPUT_BUDGET');
    expect(body).toMatch(/NOT the same string `offloadLargeValue` measures/);
  });
});

describe('the size event can be acted on', () => {
  const body = invokeStepLLMBody();

  it('records identity alongside the size', () => {
    expect(body).toMatch(/recordStepOutputSize\(stepOutput, STEP_OUTPUT_BUDGET, offloaded !== null, \{/);
    expect(body).toMatch(/tenantId: state\.context\.tenantId/);
    expect(body).toMatch(/agentId: state\.context\.agentId/);
  });
});
