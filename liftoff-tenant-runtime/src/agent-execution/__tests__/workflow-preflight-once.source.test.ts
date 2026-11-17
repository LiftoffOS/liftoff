/**
 * The engine's pre-graph passes run ONCE per turn, and both readers read the
 * same answer.
 *
 * `run_routine_now` used to return `started: true` and tell the model to
 * announce the start, while the graph was validated a second later and refused.
 * The tool now asks the engine's OWN preflight first — which is only safe if it
 * is the same pass the engine then consumes: the trigger-binding and
 * stale-alias passes REWRITE `context.workflowSteps` in memory and persist
 * nothing, so applying them twice in one turn is not obviously safe.
 *
 * The engine cannot be imported here (DB + SDK transitively), so this pins the
 * structure directly, like the other `*.source.test.ts` contracts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ENGINE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const TOOL_HANDLER = readFileSync(
  join(__dirname, '..', '..', 'tools', 'run-routine-now-handler.ts'),
  'utf8',
);

function sliceOf(from: string, to: string): string {
  const start = ENGINE.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = ENGINE.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return ENGINE.slice(start, end);
}

describe('one preflight, one result, two readers', () => {
  it('the passes live in one method, not inline in the loop body', () => {
    // Each of these is a pass that must not run twice, and each used to be
    // inline in runAgentHybridLoopBody.
    const preflight = sliceOf('private async runWorkflowPreflight(', '\n  private async runAgentHybridLoop(');
    expect(preflight).toContain('await this.buildToolsSchema(state.context)');
    expect(preflight).toContain('this.verifyWorkflowStepsHash(state.context)');
    expect(preflight).toContain('resolveTriggerBoundTool(');
    expect(preflight).toContain('validateWorkflowGraph(workflowSteps, availableToolNames, inputContract)');
    expect(preflight).toContain('const DEGRADABLE = new Set(');
    expect(preflight).toContain('resolveStepToolName(step.toolName, availableToolNames)');
  });

  it('the entry memoizes it and installs it on the cell without running it', () => {
    const entry = sliceOf('private async runAgentHybridLoop(', 'private async runAgentHybridLoopBody(');
    // Memoized on the PROMISE, so two concurrent readers cannot both start it.
    expect(entry).toContain('preflightPromise ??= this.runWorkflowPreflight(state, resumeState)');
    // Installed, not awaited: nothing is validated here.
    expect(entry).toContain('state.context.workflowRunRef.preflight = runPreflight;');
    expect(entry).not.toContain('await runPreflight()');
  });

  it('the graph entry reads that memoized outcome rather than re-running the passes', () => {
    const body = ENGINE.slice(ENGINE.indexOf('private async runAgentHybridLoopBody('));
    expect(body).toContain('const preflight = await runPreflight();');
    // The one call to the passes themselves is the memo's. A second call here
    // would apply the rewrites twice.
    expect(body).not.toContain('this.runWorkflowPreflight(');
    // And the validator is reached only through the preflight.
    expect(body).not.toContain('validateWorkflowGraph(');
  });

  it('the run_outcome metric is emitted where the RUN fails, not where the tool asks', () => {
    // A tool refusing to arm the cell is not a failed run: the conversational
    // turn carries on and answers. Emitting the outcome inside the preflight
    // would report an error for a turn that ends normally.
    const preflight = sliceOf('private async runWorkflowPreflight(', '\n  private async runAgentHybridLoop(');
    expect(preflight).not.toContain("hybrid_loop.run_outcome");
    const body = ENGINE.slice(ENGINE.indexOf('const preflight = await runPreflight();'));
    expect(body.slice(0, 600)).toContain("this.emitHybridMetric('hybrid_loop.run_outcome', state, { outcome: 'error' })");
  });

  it('the tool awaits the preflight before it reads or sets `requested`', () => {
    const armed = TOOL_HANDLER.indexOf('ctx.workflowRunRef.requested = true;');
    const asked = TOOL_HANDLER.indexOf('await ctx.workflowRunRef.preflight?.()');
    const readsRequested = TOOL_HANDLER.indexOf('if (ctx.workflowRunRef.requested)');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(readsRequested);
    expect(asked).toBeLessThan(armed);
  });
});
