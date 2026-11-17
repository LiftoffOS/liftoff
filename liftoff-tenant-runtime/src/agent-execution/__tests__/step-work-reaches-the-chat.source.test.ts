/**
 * A workflow run tells the chat what it is DOING, not only which step it is on.
 *
 * The sink carries `workflow_step_started`, so a person watching a long run
 * sees "Step 9 of 21" — and if the activity half of that line is built only
 * from whatever the CONVERSATIONAL loop dispatched, which in a workflow run is
 * almost nothing, a run that creates several documents can report:
 *
 *   "This run took 12 minutes. Work done: 16 web searches, 24 pages read,
 *    1 document written, 2 actions in Google Docs."
 *
 * where the two Google Docs actions are the `get_document` and
 * `search_documents` it opened with, and the one document is the single create
 * that came from a model-issued call. The writes dispatched by steps are
 * invisible.
 *
 * service.ts pulls DB + engine SDKs transitively, so this asserts the source in
 * the same idiom as the other *.source tests here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The step loop's own `tool_call_started` arm, which is the one that was
 *  silent. Located by the line that makes it the step loop's — the declared
 *  step output is registered only there. */
function stepLoopToolCallArm(): string {
  const at = SERVICE.indexOf("          toolsCalled.push(event.toolName);");
  expect(at).toBeGreaterThan(-1);
  return SERVICE.slice(at - 400, at + 1600);
}

describe('the step loop reports its tool calls', () => {
  it('forwards a tool call to the stream sink', () => {
    const arm = stepLoopToolCallArm();
    expect(arm).toMatch(/state\.context\.streamSink\?\.\(\{[\s\S]{0,200}type: 'tool_call_started'/);
  });

  it('forwards the tool NAME, which is what the activity line is built from', () => {
    expect(stepLoopToolCallArm()).toMatch(/type: 'tool_call_started',[\s\S]{0,120}toolName: event\.toolName/);
  });

  it('is optional-called, so an autonomous run with no sink is unaffected', () => {
    // Autonomous runs have no chat to narrate into and must not throw trying.
    expect(stepLoopToolCallArm()).toContain('state.context.streamSink?.(');
  });

  it('still counts the call for the run itself', () => {
    // The pre-existing behaviour the forward must not displace.
    expect(stepLoopToolCallArm()).toContain('state.toolCallsExecuted++');
  });
});

describe('the sink carries both halves of what a person reads', () => {
  it('the step position still reaches it', () => {
    expect(SERVICE).toMatch(/streamSink\(\{[\s\S]{0,120}type: 'workflow_step_started'/);
  });

  it('exactly one place forwards step tool calls, so nothing is counted twice', () => {
    const forwards = SERVICE.match(/streamSink\?\.\(\{\s*\n\s*type: 'tool_call_started'/g) ?? [];
    expect(forwards).toHaveLength(1);
  });
});
