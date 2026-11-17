// FITNESS FUNCTION — both adapter event loops feed the chat stream.
//
// `runAgentHybridLoop` branches on whether the agent has workflow steps:
// none -> `runConversationalTurnsViaAdapter`, some -> `invokeStepLLM`. Both
// iterate `adapter.invoke(...)` and both see the same InvocationEvent types.
// Only the conversational one forwarded them to `state.context.streamSink`.
//
// So a workflow-shaped run emitted nothing to the thread between the question
// and the answer, and the test harness — which builds its entire trace from
// that sink — reported `toolCalls: []`, zero tokens and an empty `finalText`
// for runs that had done all their work. `assertScenario` fails on `!resp.ok`
// and `ok` needs a `completion` event, so every scenario failed against a
// workflow-shaped agent.
//
// This is not an edge case: the distiller is prompted to emit workflowSteps for
// anything with a procedure (distill-cache v5/v6 make a `## Workflows` section a
// dominant trigger and narrow omission to purely ad-hoc conversational roles),
// so the blind loop is the DEFAULT shape.
//
// Asserted against source because the property is about two loops agreeing, and
// a behavioural test would exercise one of them.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The body of each `for await (const event of adapter.invoke(...))` loop, to
 *  the depth a relay would be written at. */
function eventLoopBodies(): string[] {
  // Both loops iterate the adapter chosen for this run. The conversational one
  // and the workflow one now name it `engine`, because for a customer-funded
  // Grok turn the adapter is selected by the CREDENTIAL rather than by the
  // resolved provider (see adapter/funding.ts).
  return SERVICE
    .split(/for await \(const event of \w+\.invoke\(invocationInput, abortController\.signal\)\)/)
    .slice(1)
    .map((chunk) => chunk.slice(0, 6000));
}

describe('every adapter event loop relays to the chat sink', () => {
  it('has exactly the two loops this test knows about', () => {
    // A third loop would be a third place to forget. Fail here rather than
    // silently asserting about two of three.
    expect(eventLoopBodies()).toHaveLength(2);
  });

  it('forwards events to streamSink from both', () => {
    for (const body of eventLoopBodies()) {
      expect(body).toContain('state.context.streamSink');
    }
  });

  it('does not report a STEP completion as the run completing', () => {
    // The one event that must not be forwarded from the workflow loop: there it
    // means one step ended, and a sixteen-step run would tell the chat it had
    // finished sixteen times. The conversational loop forwards it, correctly,
    // because there it is the run.
    const [conversational, workflow] = eventLoopBodies();
    expect(workflow).toContain("event.type !== 'completion'");
    expect(conversational).not.toContain("event.type !== 'completion'");
  });
});
