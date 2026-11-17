// A graph that never converges is an outcome, not a warning.
//
// A distillation used to end that state with "completed successfully": the
// last attempt's steps were dropped and the artifact went out prose-only. A
// scheduled sweep whose template declared an idempotency check, a document to
// write and a series to compare was created with none of them enforced, and
// the completion screen looked exactly like a hire that had all three.
// Meanwhile a retry that answered a graph rejection by returning NO graph
// passed every graph fence by having nothing to check.
//
// Source-level, as the other distill loop tests are: the module drags in
// proto-gen, which does not resolve inside a worktree.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');
const REDISTILL = readFileSync(join(__dirname, '..', 'redistill-service.ts'), 'utf8');
const ROUTER = readFileSync(join(__dirname, '..', 'distill-stream-router.ts'), 'utf8');

describe('a retry that drops the graph is rejected, against the graph it dropped', () => {
  const block = SRC.slice(
    SRC.indexOf("if (rejectedShape.size > 0 && (!workflowSteps || workflowSteps.length === 0)) {"),
    SRC.indexOf('if (workflowSteps && workflowSteps.length > 0) {', SRC.indexOf("if (rejectedShape.size > 0 && (!workflowSteps")),
  );

  it('rejects with graph_dropped_on_retry while attempts remain', () => {
    expect(block).toContain("type: 'graph_dropped_on_retry'");
    expect(block).toContain('attempt < MAX_RETRIES - 1');
    expect(block).toContain("callOutcome = 'validation_failed'");
  });

  it('replays the rejected graph, not the graphless answer, so the model can restore it', () => {
    expect(block).toContain('lastAttempt = { toolCallId: lastRejectedGraphAttempt.toolCallId, input: lastRejectedGraphAttempt.input };');
    expect(block).toContain('lastRejectedGraphAttempt.feedback');
  });

  it('records the drop on the final attempt instead of shipping silently', () => {
    expect(block).toContain("droppedGraph = { reasons: [dropped.type], stepCount: 0 };");
  });
});

describe('an obligated hire that emits no graph is asked for one before it is judged', () => {
  const block = SRC.slice(
    SRC.indexOf('const obligatedHire = requiresIdempotencyCheck'),
    SRC.indexOf('if (workflowSteps && workflowSteps.length > 0) {', SRC.indexOf('const obligatedHire = requiresIdempotencyCheck')),
  );

  it('rejects a first graphless attempt with graph_required while attempts remain', () => {
    expect(block).toContain("reason: 'graph_required'");
    expect(block).toContain('attempt < MAX_RETRIES - 1');
    expect(block).toContain("callOutcome = 'validation_failed'");
  });
});

describe('the terminal decision is on the graph the artifact ends with', () => {
  const block = SRC.slice(
    SRC.indexOf('const finalSteps = agentResult.workflowSteps ?? [];'),
    SRC.indexOf('// Cache only structurally-clean results'),
  );

  it('judges the final state, so a graph never emitted counts the same as one dropped', () => {
    expect(block).toContain('finalSteps.length === 0');
    expect(block).toContain("droppedGraph?.reasons ?? ['graph_never_emitted']");
  });

  it('requires a graph of an obligated hire, and of a scheduled hire whose graph was lost', () => {
    expect(block).toContain("const scheduled = triggerConfig?.type === 'cron' || triggerConfig?.type === 'event';");
    expect(block).toContain('requiresIdempotencyCheck || requiresChatThreadStep || producesDocument');
    expect(block).toContain('const requiresGraph = obligated || (scheduled && droppedGraph !== null);');
    expect(block).toContain('throw new DistillationGraphNotConvergedError(reasons, stepCount, MAX_RETRIES);');
  });

  it('exempts nobody by agentId: a redistill fails the same way, which is what makes it atomic', () => {
    expect(block).not.toContain('isRedistill');
    expect(block).not.toContain('input.agentId)');
  });

  it('lets an unobligated conversational hire ship, carrying the drop', () => {
    expect(block).toContain('agentResult.graphDropped = { reasons, stepCount };');
  });

  it('logs the outcome whichever way it went', () => {
    expect(block).toContain("metric: 'distill.graph_dropped'");
    expect(block).toContain("outcome: requiresGraph ? 'failed' : 'shipped_prose_only'");
  });

  it('never caches a dropped-graph artifact', () => {
    expect(SRC).toContain('if (input.tenantId && !droppedGraph) {');
  });

  it('does not judge a scoped rebuild, which authors no graph', () => {
    const gate = SRC.slice(SRC.indexOf('if (!input.scope) {', SRC.indexOf('The terminal decision on the graph this artifact ENDS with')), SRC.indexOf('const finalSteps'));
    expect(gate).toContain('if (!input.scope) {');
  });
});

describe('a redistill whose rebuild lost its graph is not applied at all', () => {
  it('throws before any field of the incumbent configuration is replaced', () => {
    const fn = REDISTILL.slice(
      REDISTILL.indexOf('function buildUpdatePayload('),
      REDISTILL.indexOf('return base;'),
    );
    const throwAt = fn.indexOf('throw new DistillationGraphNotConvergedError(');
    const mergeAt = fn.indexOf('mergeDistillIntegrationConfigs(');
    expect(throwAt).toBeGreaterThan(-1);
    expect(throwAt).toBeLessThan(mergeAt);
    expect(fn).toContain("metric: 'redistill.rebuild_not_applied'");
    // The incumbent-only-graph patch is gone: nothing is kept piecemeal.
    expect(REDISTILL).not.toContain('incumbent_graph_kept');
  });

  it('both redistill routes name the outcome the way the hire flow does', () => {
    const routes = readFileSync(join(__dirname, '..', 'router.ts'), 'utf8');
    const hits = routes.split("errorCode: 'graph_not_converged'").length - 1;
    expect(hits).toBe(2);
    expect(routes).toContain('status: 422,');
  });
});

describe('the stream router names the outcome to the caller', () => {
  it('sends graph_not_converged with the rejection types and no invented copy', () => {
    const block = ROUTER.slice(
      ROUTER.indexOf('if (error instanceof DistillationGraphNotConvergedError) {'),
      ROUTER.indexOf('} else if (error instanceof DistillationStructuralError) {'),
    );
    expect(block).toContain("errorCode: 'graph_not_converged'");
    expect(block).toContain("message: ''");
    expect(block).toContain('rejections: error.reasons');
  });
});
