// The dashboard diagram was drawn by a model that never saw the agent's steps.
//
// `computeWorkflowVisualizationSteps(role, systemPrompt, userInstructions)` took
// three arguments and none of them was the graph. So it was not describing the
// agent; it was reading a job description and imagining what the work probably
// looks like. Nothing afterwards compared the picture to the agent.
//
// For example, a review agent's diagram could carry
//
//     if high-risk  ->  "Find senior engineer"  ->  "Hand off to senior"
//
// while the instructions it was handed said, in as many words, "do not name an
// individual and do not route the review anywhere", and the executable graph had
// no such step. The agent behaves correctly throughout. Only the person reading
// the dashboard is told something that never happens.
//
// Two halves here, and the second is the one that holds: the prompt now carries
// the steps (cooperative), and `groundToGraph` drops any node that names none
// (enforcing). An instruction is a hope about the model; the filter is a fact
// about the output.

import { groundToGraph } from '../workflow-visualization-steps-service';
import type { WorkflowVisualizationStep } from '../types';

const GRAPH = [
  { stepId: 's1', description: 'Fetch the diff' },
  { stepId: 's9', description: 'Analyse the diff' },
  { stepId: 's13', description: 'Notify Slack' },
];

describe('a node that names no executable step does not survive', () => {
  it('drops a branch that names no step', () => {
    // Shaped like a stored workflow_visualization_steps row set.
    const nodes: WorkflowVisualizationStep[] = [
      { id: 'fetch-pr-diff', stepId: 's1', label: 'Fetch PR diff' },
      {
        id: 'assess', stepId: 's9', label: 'Assess risk',
        fork: { paths: [{
          condition: 'if high-risk',
          steps: [
            { id: 'find-senior', label: 'Find senior engineer' },
            { id: 'handoff-pr', label: 'Hand off to senior' },
          ],
        }] },
      },
    ];
    const out = groundToGraph(nodes, GRAPH)!;

    expect(JSON.stringify(out)).not.toContain('senior');
    expect(out.map((n) => n.stepId)).toEqual(['s1', 's9']);
    // The fork had exactly one path and every node in it was invented, so the
    // path goes and the fork goes with it — leaving the real step it hung off.
    expect(out[1].fork).toBeUndefined();
  });

  it('drops a node whose stepId names a step that does not exist', () => {
    const out = groundToGraph(
      [{ id: 'x', stepId: 's99', label: 'Do a thing' }], GRAPH,
    );
    expect(out).toBeNull();
  });

  it('drops a node carrying no stepId at all', () => {
    // What every node looked like before this change.
    const out = groundToGraph([{ id: 'x', label: 'Do a thing' }], GRAPH);
    expect(out).toBeNull();
  });

  it('keeps real nodes when only some are invented', () => {
    // One bad node costs that node, not the whole picture.
    const out = groundToGraph([
      { id: 'a', stepId: 's1', label: 'Fetch PR diff' },
      { id: 'b', label: 'Ask the architect' },
      { id: 'c', stepId: 's13', label: 'Notify Slack' },
    ], GRAPH)!;
    expect(out.map((n) => n.label)).toEqual(['Fetch PR diff', 'Notify Slack']);
  });
});

describe('forks are pruned rather than trusted or discarded whole', () => {
  it('keeps a path whose steps are real and drops one whose steps are not', () => {
    const out = groundToGraph([{
      id: 'branch', stepId: 's9', label: 'Assess risk',
      fork: { paths: [
        { condition: 'if clean', steps: [{ id: 'n', stepId: 's13', label: 'Notify Slack' }] },
        { condition: 'if high-risk', steps: [{ id: 'f', label: 'Page the on-call' }] },
      ] },
    }], GRAPH)!;

    expect(out[0].fork!.paths).toHaveLength(1);
    expect(out[0].fork!.paths[0].condition).toBe('if clean');
  });

  it('prunes a nested invented node without losing its real siblings', () => {
    const out = groundToGraph([{
      id: 'branch', stepId: 's9', label: 'Assess risk',
      fork: { paths: [{
        condition: 'if clean',
        steps: [
          { id: 'n', stepId: 's13', label: 'Notify Slack' },
          { id: 'ping', label: 'Ping the reviewer' },
        ],
      }] },
    }], GRAPH)!;

    expect(out[0].fork!.paths[0].steps.map((s) => s.label)).toEqual(['Notify Slack']);
  });
});

describe('what it deliberately does not do', () => {
  it('leaves the diagram alone when the agent has no graph to check against', () => {
    // An agent with no workflowSteps has nothing to be wrong about. Demanding a
    // stepId there would delete every diagram it has, which is worse than the
    // drift this guards. Same choice verify-migrations.sh makes: a check that
    // could not run knows nothing.
    const nodes = [{ id: 'x', label: 'Do a thing' }];
    expect(groundToGraph(nodes, null)).toEqual(nodes);
    expect(groundToGraph(nodes, [])).toEqual(nodes);
  });

  it('does not rewrite labels, ids or fork conditions on a node it keeps', () => {
    // It answers "does this step exist", never "is this a good description".
    const node = {
      id: 'fetch-pr-diff', stepId: 's1', label: 'Fetch PR diff',
      fork: { paths: [{ condition: 'if reopened', steps: [{ id: 'n', stepId: 's13', label: 'Notify Slack' }] }] },
    };
    expect(groundToGraph([node], GRAPH)).toEqual([node]);
  });

  it('survives a malformed node without throwing', () => {
    // The input is model output; it is not guaranteed to be the shape declared.
    const out = groundToGraph(
      [null as never, { id: 'a', stepId: 's1', label: 'Fetch PR diff', fork: { paths: undefined as never } }],
      GRAPH,
    )!;
    expect(out).toHaveLength(1);
    expect(out[0].stepId).toBe('s1');
  });
});

describe('the generator is actually given the steps', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'workflow-visualization-steps-service.ts'), 'utf8',
  ) as string;

  it('passes the graph into the prompt', () => {
    // The filter alone would leave a correct-but-empty diagram, because a model
    // that cannot see the steps cannot name them. Both halves are needed.
    expect(SRC).toMatch(/PROMPT\(role, systemPrompt, userInstructions, workflowSteps\)/);
  });

  it('tells the model a written sentence is not a step', () => {
    // The precise confusion that produced "Find senior engineer": the agent
    // WRITES that a person should look, and the model drew it as an action.
    // Whitespace-tolerant: the phrase wraps across lines in the prompt, and a
    // literal-space regex fails on the wrap while the prompt is perfectly fine.
    expect(SRC).toMatch(/needs a person to\s+look/);
  });

  it('every caller hands over the graph', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'service.ts'), 'utf8',
    ) as string;
    const distill = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'distill-router.ts'), 'utf8',
    ) as string;
    // create, update, and the Optimize preview. A caller that forgets silently
    // returns to imagining the picture.
    expect(svc).toContain('input.workflowSteps ?? null');
    expect(svc).toContain('input.workflowSteps ?? current.workflowSteps ?? null');
    expect(distill).toContain('result.workflowSteps ?? null');
  });
});
