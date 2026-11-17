/**
 * Interactive chat converses by default; the step graph runs in chat only on
 * an explicit run_routine_now invocation.
 *
 * The hybrid dispatch used to branch on nothing but the PRESENCE of
 * workflowSteps, so a populated graph captured every chat message as a
 * schedule tick: the user's message was only ever "objective" context, the
 * model never chose, and a question about the work ran the work (a
 * multi-minute sweep, real document writes, and a fabricated "the Monday run
 * has been skipped" narrated off a duplicate-guard early exit).
 *
 * The engine cannot be imported here (DB + SDK transitively), so this pins
 * the structure directly, like the other `*.source.test.ts` contracts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ENGINE = readFileSync(
  join(__dirname, '..', '..', 'agent-execution', 'service.ts'),
  'utf8',
);
const HANDLER = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');
const GATEWAY = readFileSync(
  join(__dirname, '..', '..', 'tool-gateway', 'mcp-server.ts'),
  'utf8',
);
const TOOL_HANDLER = readFileSync(
  join(__dirname, '..', '..', 'tools', 'run-routine-now-handler.ts'),
  'utf8',
);

/** The hybrid entry and the conversational branch: from `runAgentHybridLoop`
 *  down to the point where the graph's own preflight begins. The tool catalog
 *  build that used to mark the end of it now lives in `runWorkflowPreflight`,
 *  which `run_routine_now` awaits from inside the conversational segment. */
function dispatchSource(): string {
  const start = ENGINE.indexOf('private async runAgentHybridLoop(');
  expect(start).toBeGreaterThan(-1);
  const end = ENGINE.indexOf('const preflight = await runPreflight();', start);
  expect(end).toBeGreaterThan(start);
  return ENGINE.slice(start, end);
}

describe('interactive chat converses by default', () => {
  it('the dispatch routes interactive turns conversational unless the run was requested', () => {
    const dispatch = dispatchSource();
    // The three legs of the condition, each load-bearing:
    // interactive detection by the established systemPromptOverride convention,
    expect(dispatch).toContain("Boolean(state.context.systemPromptOverride)");
    // the kill switch,
    expect(dispatch).toContain('chatConversationalDefaultEnabled()');
    // and the explicit-request cell.
    expect(dispatch).toContain("workflowRunRef?.requested !== true");
  });

  it('a conversational pause resumes conversational, by the reserved stepId', () => {
    const dispatch = dispatchSource();
    expect(dispatch).toContain("resumeState?.currentStepId === 'conversational'");
  });

  it('the fall-through to the graph requires a FINISHED conversational segment', () => {
    const dispatch = dispatchSource();
    // A pause owes its person a decision; resolveTerminalState is the rule
    // (never raw booleans).
    expect(dispatch).toContain('resolveTerminalState(conversational, false)');
  });

  it('the chat handler creates the cell only when there is a graph to run', () => {
    expect(HANDLER).toContain(
      'workflowStepsEnabled() && agentMeta.hasWorkflowSteps && chatConversationalDefaultEnabled()',
    );
    // The SAME cell goes to the catalog and to executeTask — the trustRef
    // pattern; two different objects would make the tool's write invisible.
    const catalogPass = HANDLER.indexOf('workflowRunRef: chatWorkflowRunRef');
    expect(catalogPass).toBeGreaterThan(-1);
    expect(HANDLER.indexOf('workflowRunRef: chatWorkflowRunRef', catalogPass + 1)).toBeGreaterThan(-1);
  });

  it('both catalog enumerations gate run_routine_now on the cell, identically', () => {
    // buildToolsSchema half.
    expect(ENGINE).toContain(
      "t.name !== 'run_routine_now' || runRoutineArmed",
    );
    expect(ENGINE).toContain(
      'context.workflowRunRef !== undefined && context.workflowRunRef.requested !== true',
    );
    // MCP catalog half — outside its try/catch so the unfiltered fallback
    // cannot over-expose the tool.
    expect(GATEWAY).toContain("t.name !== 'run_routine_now'");
    expect(GATEWAY).toContain(
      'workflowRunRef !== undefined && workflowRunRef.requested !== true',
    );
  });

  it('the tool refuses truthfully outside interactive chat', () => {
    expect(TOOL_HANDLER).toContain('success: false');
    expect(TOOL_HANDLER).toContain('Nothing was started');
  });
});
