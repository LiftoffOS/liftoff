// A workflow that executes nothing must not report success.
//
// The executor dispatches on delay / ask_user / llm_reason, then on toolName,
// and everything else falls to a final `else` that advances doing nothing. So a
// step with no type and no toolName is a SILENT NO-OP, not a crash. One among
// real steps is a placeholder; all of them is a run that walks its graph,
// executes nothing, and completes successfully — the fabricated success
// INV-TR-004 forbids.
//
// The shape is realistic: a distiller can produce steps carrying only
// description, stepId, onSuccess and outputField.

import { validateWorkflowGraph } from '../validate-workflow-graph';
import type { WorkflowStep } from '../types';

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ description: 'd', ...o } as WorkflowStep);

describe('a step the trigger pass retired', () => {
  // `trigger__<op>` names an operation, not a tool, so no catalog holds one and
  // no dispatch family resolves one. The executor rewrites these before
  // validation — but only the ones it RESOLVES. A step it decides to skip keeps
  // its `trigger__` name, and validation then judged it and failed the whole
  // run for a step the runtime had already decided not to execute.
  //
  // That silently broke the host-agnostic review graph: on GitLab, which posts
  // notes directly and has no pending review to open or publish, the begin and
  // publish steps skip — and the run died at validation instead of doing the
  // work the other steps describe.
  const retired = (stepId: string): WorkflowStep =>
    step({ stepId, toolName: 'trigger__pr_review_begin', __triggerBoundSkip: 'gitlab posts notes directly' });

  const CATALOG = new Set(['github-1a2b3c4d__pull_request_read']);

  it('is not reported unresolvable against the catalog', () => {
    expect(validateWorkflowGraph([retired('s1')], CATALOG).map((e) => e.code))
      .not.toContain('UNRESOLVABLE_TOOL');
  });

  it('still judges a step that was NOT retired', () => {
    // The control. Without it the test above passes for the wrong reason — the
    // dispatch check cannot see these names at all, because `trigger__pr_get`
    // splits like any `<alias>__<fn>` connector tool and resolves to the
    // `connector` family. Only the CATALOG check ever flags one, so only the
    // catalog check needed a guard.
    expect(validateWorkflowGraph([step({ stepId: 's1', toolName: 'trigger__pr_review_begin' })], CATALOG)
      .map((e) => e.code)).toContain('UNRESOLVABLE_TOOL');
  });
});

describe('a workflow that would do nothing', () => {
  it('rejects a graph whose every step is a no-op', () => {
    // The exact no-op shape.
    const errors = validateWorkflowGraph([
      step({ stepId: 's1', onSuccess: 's2', outputField: 'x' }),
      step({ stepId: 's2', outputField: 'y' }),
    ]);
    expect(errors.map((e) => e.code)).toContain('NO_OP_WORKFLOW');
  });

  it('allows one no-op placeholder among steps that do work', () => {
    // A single inert step is a design choice, not a lie. Only a workflow that
    // is inert END TO END reports success for nothing.
    const errors = validateWorkflowGraph([
      step({ stepId: 's1', type: 'llm_reason', onSuccess: 's2' }),
      step({ stepId: 's2' }),
    ]);
    expect(errors.map((e) => e.code)).not.toContain('NO_OP_WORKFLOW');
  });

  it('counts a toolName-only step as real work, per the documented default', () => {
    const errors = validateWorkflowGraph([step({ stepId: 's1', toolName: 'slack__send_message' })]);
    expect(errors.map((e) => e.code)).not.toContain('NO_OP_WORKFLOW');
  });

  it('counts every explicit type as real work', () => {
    for (const t of ['llm_reason', 'ask_user', 'delay', 'tool_call'] as const) {
      const errors = validateWorkflowGraph([step({ stepId: 's1', type: t })]);
      expect(errors.map((e) => e.code)).not.toContain('NO_OP_WORKFLOW');
    }
  });

  it('flags a type no executor handles', () => {
    // With a toolName it silently runs as a tool call; without one it is a
    // no-op. Either way what executes is not what was asked for.
    const errors = validateWorkflowGraph([
      step({ stepId: 's1', type: 'summarise' as never, toolName: 'slack__send_message' }),
    ]);
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_STEP_TYPE');
  });

  it('says nothing about an empty workflow, which is the conversational path', () => {
    expect(validateWorkflowGraph([])).toEqual([]);
  });
});

// UNDISPATCHABLE_TOOL — being in the catalog is not being executable.
//
// The catalog check (UNRESOLVABLE_TOOL) asks whether the agent HOLDS the tool.
// It cannot see a name that the agent holds and no subsystem can route, which
// is what every sandbox / agent_slack / agent_teams / delegate_to_agent step
// was: present in the catalog, validated clean, dead at dispatch. This check
// asks the second question, and runs whether or not a catalog was loaded,
// because dispatchability is a property of the runtime rather than of the
// agent's bindings.
describe('a tool no subsystem can dispatch', () => {
  it('rejects a step naming a tool that resolves to no family', () => {
    const errors = validateWorkflowGraph([
      step({ stepId: 's1', type: 'tool_call', toolName: 'totally_invented_tool' }),
    ]);
    expect(errors.map((e) => e.code)).toContain('UNDISPATCHABLE_TOOL');
  });

  it.each([
    ['sandbox', 'shell_exec'],
    ['code_session', 'code_session'],
    ['agent_slack', 'slack_send_message'],
    ['agent_teams', 'teams_send_message'],
    ['builtin', 'delegate_to_agent'],
    ['standard', 'note_save'],
    ['connector', 'google-mail-14a82d9e__get_thread'],
  ])('accepts a %s step (%s)', (_family, toolName) => {
    const errors = validateWorkflowGraph([
      step({ stepId: 's1', type: 'tool_call', toolName }),
    ]);
    expect(errors.map((e) => e.code)).not.toContain('UNDISPATCHABLE_TOOL');
  });

  it('fires without a catalog, which the membership check cannot do', () => {
    // validateWorkflowGraph skips UNRESOLVABLE_TOOL when the catalog is empty
    // or absent, because an empty set means "could not load" rather than "no
    // tools". Dispatchability has no such ambiguity.
    const errors = validateWorkflowGraph(
      [step({ stepId: 's1', type: 'tool_call', toolName: 'totally_invented_tool' })],
      new Set<string>(),
    );
    expect(errors.map((e) => e.code)).toContain('UNDISPATCHABLE_TOOL');
    expect(errors.map((e) => e.code)).not.toContain('UNRESOLVABLE_TOOL');
  });
});

// UNRESOLVABLE_TOOL must NOT fire for a universal dispatchable builtin.
//
// availableToolNames comes from buildToolsSchema, which enumerates connectors,
// sandbox, standard and external-agent tools — never the platform callbacks. So
// find_teammates / send_agent_message / read_agent_messages are absent from a
// real agent's catalog while being fully dispatchable from the __builtin:
// branch. Reporting them UNRESOLVABLE is a false positive that failed EVERY
// turn of the first self-serve subscriber's agent, whose distilled graph wired
// a find_teammates step (s8). The dispatchability check owns these names.
describe('a universal builtin absent from the per-agent catalog', () => {
  // A real agent's catalog: its bound connector + a standard tool, no builtins.
  const agentCatalog = new Set(['google-mail-14a82d9e__get_thread', 'note_save']);

  it.each(['find_teammates', 'send_agent_message', 'read_agent_messages', 'delegate_to_agent'])(
    'does not report %s UNRESOLVABLE even though the catalog lacks it',
    (toolName) => {
      const errors = validateWorkflowGraph(
        [step({ stepId: 's1', type: 'tool_call', toolName })],
        agentCatalog,
      );
      expect(errors.map((e) => e.code)).not.toContain('UNRESOLVABLE_TOOL');
      expect(errors.map((e) => e.code)).not.toContain('UNDISPATCHABLE_TOOL');
    },
  );

  it('still reports a genuinely missing connector tool UNRESOLVABLE', () => {
    // The membership check keeps doing its one job: an agent that does not hold
    // Salesforce cannot run a Salesforce step.
    const errors = validateWorkflowGraph(
      [step({ stepId: 's1', type: 'tool_call', toolName: 'salesforce-99__create_lead' })],
      agentCatalog,
    );
    expect(errors.map((e) => e.code)).toContain('UNRESOLVABLE_TOOL');
  });

  it('a find_teammates step raises neither validation error', () => {
    const errors = validateWorkflowGraph(
      [step({ stepId: 's8', type: 'tool_call', toolName: 'find_teammates' })],
      agentCatalog,
    );
    expect(errors.map((e) => e.code)).not.toContain('UNRESOLVABLE_TOOL');
    expect(errors.map((e) => e.code)).not.toContain('UNDISPATCHABLE_TOOL');
  });
});

// An onFailure branch is a route, not an excuse.
//
// The workflow loop's catch routed to `step.onFailure` and `continue`d before
// any bookkeeping: the failed step was not recorded as unsatisfied and no
// anomaly was emitted, so a run whose first step never produced its output
// could still end `success`. onFailure routes are common in authored graphs,
// so this silence reaches most agents.
//
// The behavioural halves are asserted at the loop level; what is pinned here is
// that the source still does the bookkeeping before it branches — the exact
// lines a future edit would drop.
describe('the onFailure branch records what it swallows', () => {
  const loopSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('adds the step to unsatisfiedSteps before routing', () => {
    const branch = loopSource.slice(
      loopSource.indexOf('const isContractDefect'),
      loopSource.indexOf('currentStepId = step.onFailure;') + 40,
    );
    expect(branch).toContain('unsatisfiedSteps.add(step.stepId)');
    expect(branch).toContain('hybrid_loop.anomaly_triggered');
  });

  it('excludes an UNREADABLE template reference from onFailure routing', () => {
    // A step whose inputs could not be built was never attempted. onFailure
    // means "this operation can fail in the course of business"; a broken input
    // contract is a defect, and routing it down the author's failure branch
    // presents one as the other.
    expect(loopSource).toContain('e instanceof TemplateResolutionError && !e.producedNull');
    expect(loopSource).toMatch(/if\s*\(step\.onFailure\s*&&\s*!isPauseSignal\s*&&\s*!isContractDefect\)/);
  });

  it('does NOT exclude a reference the producing step reported as null', () => {
    // The opposite case, and the common one. A null means the producing step
    // RAN and said nothing is there — "no snapshot document yet" — which is
    // precisely what an author writing `onFailure: <create one>` was answering.
    // Treating it as a defect spends a recovery model turn rediscovering a fact
    // the graph already states, on every first run of every "update it, or make
    // it if it is missing" workflow.
    expect(loopSource).toContain('!e.producedNull');
  });
});
