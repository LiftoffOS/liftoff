// Refusing to store a workflow the runtime cannot run.
//
// The distiller validated its own output; every other writer into
// service.create / service.update did not, so a step that could never execute
// was persisted without complaint. These pin what counts as unrunnable, and —
// just as importantly — what does not, since an over-eager check here blocks
// operators from editing agents they did not break.

import {
  findWorkflowStepProblems,
  assertWorkflowStepsExecutable,
  eventSourcesForAgent,
  UnrunnableWorkflowError,
} from '../workflow-steps-executable';

const codes = (steps: Parameters<typeof findWorkflowStepProblems>[0]): string[] =>
  findWorkflowStepProblems(steps).map((p) => p.code);

describe('what cannot be stored', () => {
  it('refuses a workflow where every step is a no-op', () => {
    // The no-op shape: description + stepId + onSuccess, no type, no tool.
    // The runtime would walk it, execute nothing, and report success.
    expect(codes([
      { stepId: 's1', onSuccess: 's2' },
      { stepId: 's2' },
    ])).toContain('NO_OP_WORKFLOW');
  });

  it('refuses a type no executor handles', () => {
    expect(codes([{ stepId: 's1', type: 'summarise', toolName: 'x' }]))
      .toContain('UNKNOWN_STEP_TYPE');
  });

  it('refuses a reference to a step that does not exist', () => {
    expect(codes([{ stepId: 's1', type: 'llm_reason', onSuccess: 'nowhere' }]))
      .toContain('DANGLING_REF');
  });

  it('refuses two steps sharing an id', () => {
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's1' },
      { stepId: 's1', type: 'llm_reason' },
    ])).toContain('DUPLICATE_STEP_ID');
  });

  it('refuses steps stranded off the entry chain', () => {
    // A distilled graph can jump from one step past several others, orphaning
    // the middle of the graph. The runtime hard-fails the entire run on this.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      { stepId: 's2', type: 'llm_reason', onSuccess: 's5' },
      { stepId: 's3', type: 'llm_reason', onSuccess: 's4' },
      { stepId: 's4', type: 'llm_reason' },
      { stepId: 's5', type: 'llm_reason' },
    ])).toContain('UNREACHABLE_STEP');
  });
});

describe('what must still be storable', () => {
  it('accepts a linear typed workflow', () => {
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      { stepId: 's2', type: 'tool_call', toolName: 'slack__send_message' },
    ])).toEqual([]);
  });

  it('accepts the documented back-compat: toolName with no type', () => {
    expect(codes([{ stepId: 's1', toolName: 'slack__send_message' }])).toEqual([]);
  });

  it('accepts one inert placeholder among steps that do work', () => {
    // Only an END TO END inert workflow lies about what it did.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      { stepId: 's2' },
    ])).toEqual([]);
  });

  it('accepts a branch reached only by onFailure', () => {
    // Reachability must follow both edges, or every error path looks orphaned.
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2', onFailure: 's3' },
      { stepId: 's2', type: 'llm_reason' },
      { stepId: 's3', type: 'llm_reason' },
    ])).toEqual([]);
  });

  it('says nothing about an empty or absent workflow', () => {
    // No steps is the conversational agent, which is most of the fleet.
    expect(() => assertWorkflowStepsExecutable([])).not.toThrow();
    expect(() => assertWorkflowStepsExecutable(null)).not.toThrow();
    expect(() => assertWorkflowStepsExecutable(undefined)).not.toThrow();
  });
});

describe('the error a caller sees', () => {
  it('names every problem rather than only the first', () => {
    try {
      assertWorkflowStepsExecutable([
        { stepId: 's1', type: 'nonsense', onSuccess: 'nowhere' },
      ]);
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as UnrunnableWorkflowError;
      expect(err.name).toBe('UnrunnableWorkflowError');
      expect(err.problems.map((p) => p.code).sort())
        .toEqual(['DANGLING_REF', 'NO_OP_WORKFLOW', 'UNKNOWN_STEP_TYPE']);
      expect(err.message).toContain('DANGLING_REF');
    }
  });
});

describe('references that can never resolve', () => {
  it('refuses a condition root the runtime does not populate', () => {
    // `$.output.x` parses and then reads nothing on every run, so the branch is
    // silently never taken. The runtime hands conditions { input, steps, item }.
    expect(codes([
      { stepId: 's1', type: 'llm_reason', condition: "$.output.verdict == 'ok'" },
    ])).toContain('UNADDRESSABLE_REF');
  });

  // Both strings below are realistic agent backbones. Neither names a root, so
  // a reference scan finds nothing to complain about and they ship -- then the
  // runtime's parser throws on them and every run of those agents dies at the
  // first conditional step.
  it.each([
    ["output.routing.next == 'review'"],
    ['output.ticket.proceed == true'],
  ])('refuses a condition that reads nothing addressable: %s', (condition) => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'llm_reason', condition },
    ]);
    expect(problems.map((p) => p.code)).toContain('UNADDRESSABLE_REF');
    expect(problems[0].message).toContain(condition);
  });

  // The absence check must not fire on conditions that DO reference something,
  // including the ones already refused for a different reason -- otherwise a
  // single bad root would report twice and the message would mislead.
  it('does not double-report a condition that names an unreadable root', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'llm_reason', condition: "$.output.verdict == 'ok'" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('$.output');
  });

  // A realistic case: the distiller writes the precondition into
  // `description`, which the runtime never reads, and leaves `condition` unset
  // -- so the step asks on every run. Asked to summarise "all my repos", which
  // names every repository, it stops and asks which repository.
  it('refuses an ask_user step whose precondition is only in prose', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      {
        stepId: 's2', type: 'ask_user',
        description: 'Ask which repository to work in, only when step s1 could not determine it.',
      },
    ]);
    expect(problems.map((p) => p.code)).toContain('UNADDRESSABLE_REF');
    expect(problems[0].message).toMatch(/asks the person on every run/);
  });

  it.each([
    ['only if', 'Confirm the recipient list, only if it was not supplied.'],
    ['unless', 'Ask for the branch unless the ticket names one.'],
    // Verbatim from a redistill. The first version of this check matched only
    // the ADJACENT forms, so a verb between "only" and "when"/"if" walked
    // straight past it — and the ask_user among these asked on every run.
    ['only <verb> when', 'Only reached when the target repository could not be inferred.'],
    ['only <verb> if', 'Only proceed if s7 shows tests and lint both passing.'],
    ['reached only when', 'Reached only when s1 recorded a blocker.'],
  ])('catches the other conditional phrasings: %s', (_l, description) => {
    expect(codes([{ stepId: 's1', type: 'ask_user', description }])).toContain('UNADDRESSABLE_REF');
  });

  // "only" that scopes a noun rather than the step's execution. Widening the
  // match to allow a verb gap made these reachable, so each is pinned.
  it.each([
    ['a scoped noun across a semicolon', 'Only internal staff are included; if empty, skip.'],
    ['a limit followed by a new sentence', 'Only the first 20 rows are kept. If more arrive, page again.'],
    ['a bare if', 'Ask if they want the weekly summary too.'],
  ])('does not flag %s', (_l, description) => {
    expect(findWorkflowStepProblems([{ stepId: 's1', type: 'ask_user', description }])).toHaveLength(0);
  });

  // An unconditional checkpoint is legitimate and stays legal — the distiller's
  // own worked example is one. Only claiming to be conditional is the problem.
  it('accepts an ask_user step that does not claim to be conditional', () => {
    expect(findWorkflowStepProblems([
      { stepId: 's1', type: 'ask_user', description: 'Confirm recipient list' },
    ])).toHaveLength(0);
  });

  it('accepts a conditional description when the condition is actually set', () => {
    expect(findWorkflowStepProblems([
      { stepId: 's1', type: 'llm_reason', onSuccess: 's2' },
      {
        stepId: 's2', type: 'ask_user',
        description: 'Ask for the repo, only when s1 could not determine it.',
        condition: '$.steps.s1.repo is null',
      },
    ])).toHaveLength(0);
  });

  // "if" alone is not conditional intent — it appears in ordinary descriptions
  // of what to ask, and flagging it would block valid workflows.
  it('does not flag a bare "if" in a description', () => {
    expect(findWorkflowStepProblems([
      { stepId: 's1', type: 'ask_user', description: 'Ask if they want the weekly summary too.' },
    ])).toHaveLength(0);
  });

  // Other step types are left alone for now: this is scoped to the one whose
  // false firing interrupts a person.
  it('leaves a conditional-sounding tool_call alone', () => {
    expect(findWorkflowStepProblems([
      { stepId: 's1', type: 'tool_call', toolName: 'slack__send', description: 'Send only when green.' },
    ])).toHaveLength(0);
  });







  it('refuses a template placeholder the runtime renders literally', () => {
    // The distiller's own schema used to document {{now.iso}} as valid, so a
    // distilled agent could emit it. substitute() has no `now` root, so those
    // characters reach the tool arguments verbatim.
    const problems = findWorkflowStepProblems([
      {
        stepId: 's6', type: 'tool_call', toolName: 'slack__send',
        toolInputTemplate: '{"text":"BTC price log failed for the {{now.iso}} run."}',
      },
    ]);
    expect(problems.map((p) => p.code)).toContain('UNADDRESSABLE_REF');
    expect(problems[0].message).toContain('{{now.iso}}');
  });

  it('refuses a reference to a step id that does not exist', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"a":{{steps.ghost.v}}}' },
    ])).toContain('UNADDRESSABLE_REF');
  });

  it('accepts the forms the runtime does resolve', () => {
    expect(codes([
      {
        stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2',
        toolInputTemplate: '{"id":"{{input.threadId}}"}',
      },
      {
        stepId: 's2', type: 'tool_call', toolName: 't',
        condition: "$.steps.s1.status == 'open'",
        toolInputTemplate: '{"note":"ref {{steps.s1.id}}","n":{{input.count}}}',
      },
    ])).toEqual([]);
  });

  it('does not flag an escaped literal', () => {
    expect(codes([
      {
        stepId: 's1', type: 'tool_call', toolName: 't',
        toolInputTemplate: '{"note":"write \\{\\{input.x\\}\\} literally"}',
      },
    ])).toEqual([]);
  });
});

// The `input` field contract, which this gate could not see before the runtime
// normalized one. A root whitelist says `input` is substitutable; it says
// nothing about the field under it, and that gap let
// `{"id":"{{input.threadId}}"}` through every check up to and including the
// pre-flight audit, only to fail at run time.
describe('event-triggered input fields', () => {
  const gmail = ['google_mail'];
  const withSources = (steps: Parameters<typeof findWorkflowStepProblems>[0], sources: string[]) =>
    findWorkflowStepProblems(steps, sources).map((p) => p.code);

  it('refuses a raw trigger-field reference', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"id":"{{input.threadId}}"}' },
    ], gmail)).toContain('UNADDRESSABLE_REF');
  });

  it('accepts the normalized envelope', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"id":"{{input.message.threadId}}"}' },
    ], gmail)).toEqual([]);
  });

  it('refuses a condition that could never be true', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', condition: "$.input.from == 'a@b.c'" },
    ], gmail)).toContain('UNADDRESSABLE_REF');
  });

  it('accepts a condition on an envelope field', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', condition: "$.input.message.from == 'a@b.c'" },
    ], gmail)).toEqual([]);
  });

  it('leaves the raw payload escape hatch open', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"id":"{{input.eventData.thread_id}}"}' },
    ], gmail)).toEqual([]);
  });

  it('checks nothing without candidate sources, so non-event agents are untouched', () => {
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"id":"{{input.anything}}"}' },
    ], [])).toEqual([]);
  });

  it('accepts a field any candidate supplies', () => {
    // This service knows the agent's bindings, not which connector will fire.
    expect(withSources([
      { stepId: 's1', type: 'tool_call', toolName: 't', toolInputTemplate: '{"s":"{{input.message.subject}}"}' },
    ], ['github', 'google_mail'])).toEqual([]);
  });
});

describe('eventSourcesForAgent', () => {
  it('is empty for a non-event trigger, so the checks stay off', () => {
    expect(eventSourcesForAgent({ type: 'cron' }, [{ type: 'google_mail' }])).toEqual([]);
    expect(eventSourcesForAgent(null, [{ type: 'google_mail' }])).toEqual([]);
  });

  it('returns bound connector types for an event trigger', () => {
    expect(eventSourcesForAgent({ type: 'event' }, [{ type: 'google_mail' }, { type: 'slack' }]))
      .toEqual(['google_mail', 'slack']);
  });

  it('accepts integrationId as the type key', () => {
    // The stored shape drifted between `type` and `integrationId`. Reading only
    // one yields no candidates, which turns the check off without saying so.
    expect(eventSourcesForAgent({ type: 'event' }, [{ integrationId: 'google_mail' }]))
      .toEqual(['google_mail']);
  });
});

describe('capability steps', () => {
  it('accepts a capability step with a complete need — not unknown, not a no-op', () => {
    const problems = codes([
      { stepId: 's1', type: 'capability', capabilityNeed: { operation: 'enrich person', entity: 'profiles', mode: 'public_data' } },
    ]);
    expect(problems).not.toContain('UNKNOWN_STEP_TYPE');
    expect(problems).not.toContain('NO_OP_WORKFLOW');
    expect(problems).not.toContain('CAPABILITY_NEED_INCOMPLETE');
  });

  it('refuses a capability step with no capabilityNeed', () => {
    expect(codes([{ stepId: 's1', type: 'capability' }]))
      .toContain('CAPABILITY_NEED_INCOMPLETE');
  });

  it('refuses a capability step whose need is missing mode', () => {
    expect(codes([
      { stepId: 's1', type: 'capability', capabilityNeed: { operation: 'send text message', entity: 'message' } },
    ])).toContain('CAPABILITY_NEED_INCOMPLETE');
  });
});

describe('a time no step can know', () => {
  // No step is told the date, so a scheduling argument decided by a reasoning
  // step or written as a literal is invented; one read from the trigger, the
  // input or a tool's result is not.
  it('refuses a scheduling argument fed from a reasoning step', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'llm_reason', description: 'compose', outputField: 'digest' } as never,
      { stepId: 's2', type: 'tool_call', toolName: 'slack-1__schedule_message',
        toolInputTemplate: '{"channel":"#all","text":"{{steps.s1.digest}}","post_at":"{{steps.s1.post_at_epoch}}"}' },
    ]);
    const hit = problems.find((p) => p.code === 'TIME_FROM_REASONING');
    expect(hit?.stepId).toBe('s2');
    expect(hit?.message).toContain('post_at');
    expect(hit?.message).toContain('reasoning step "s1"');
    expect(hit?.field).toBeUndefined();
  });

  it('refuses a scheduling argument written as a literal', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 'slack-1__schedule_message', toolInput: { channel: '#all', text: 'hi', post_at: '1789646400' } } as never,
    ])).toContain('TIME_FROM_REASONING');
  });

  it('accepts a scheduling argument read from the input or a tool result', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 'crm-1__get_meeting', toolInputTemplate: '{"id":"{{input.meetingId}}"}' },
      { stepId: 's2', type: 'tool_call', toolName: 'slack-1__schedule_message',
        toolInputTemplate: '{"channel":"#all","text":"reminder","post_at":"{{steps.s1.remind_at}}"}' },
      { stepId: 's3', type: 'tool_call', toolName: 'slack-1__schedule_message',
        toolInputTemplate: '{"channel":"#all","text":"reminder","post_at":"{{input.post_at}}"}' },
    ])).not.toContain('TIME_FROM_REASONING');
  });

  it('leaves a time a step merely relays alone — a record\'s own timestamps are not a schedule', () => {
    expect(codes([
      { stepId: 's1', type: 'llm_reason', description: 'pick the record', outputField: 'pick' } as never,
      { stepId: 's2', type: 'tool_call', toolName: 'crm-1__update_deal',
        toolInputTemplate: '{"id":"{{steps.s1.pick.id}}","created_at":"{{steps.s1.pick.created_at}}","thread_ts":"{{steps.s1.pick.ts}}"}' },
    ])).not.toContain('TIME_FROM_REASONING');
  });
});

// `loop.over`, which was checked NOWHERE.
//
// The consequence is not a rejected write: it is a graph that cannot iterate,
// persisted, and a step whose body runs zero times without failing. A loop can
// name its collection `output.<stepId>.<field>` if the distiller's own schema
// documents that form; the per-item work is then never done, the digest has
// nothing to report, and every check upstream calls the graph clean.
describe('a loop that cannot iterate', () => {
  it('accepts every form the runtime resolves', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
      { stepId: 's2', type: 'tool_call', toolName: 't', loop: { over: 'steps.s1.findings' }, onSuccess: 's3' },
      { stepId: 's3', type: 'tool_call', toolName: 't', loop: { over: '{{steps.s1.findings}}' }, onSuccess: 's4' },
      { stepId: 's4', type: 'tool_call', toolName: 't', loop: { over: 'items' }, onSuccess: 's5' },
      // `output.<field>` with no second segment is the previous step's own
      // output read correctly, which is exactly what `output` means.
      { stepId: 's5', type: 'tool_call', toolName: 't', loop: { over: 'output.rows' } },
    ])).toEqual([]);
  });

  it('refuses a loop on a step with nothing to run per item', () => {
    // The runtime dispatches a loop body on `toolName`, or on llm_reason /
    // capability through the step LLM. A looped step that is neither walks its
    // collection and executes NOTHING, then reports success.
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'delay', loop: { over: 'items' } } as never,
    ]);
    const hit = problems.find((p) => p.field === 'loop');
    expect(hit?.code).toBe('UNADDRESSABLE_REF');
    expect(hit?.message).toContain('nothing to run per item');
  });

  it('accepts a loop on a reasoning step, which the runtime runs per item', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
      { stepId: 's2', type: 'llm_reason', loop: { over: 'steps.s1.competitors' } } as never,
    ])).toEqual([]);
  });

  it('refuses a collection the runtime will not substitute', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'tool_call', toolName: 't', loop: { over: '{{now.iso}}' } },
    ]);
    expect(problems.map((p) => p.code)).toContain('UNADDRESSABLE_REF');
    expect(problems.find((p) => p.field === 'loop')).toBeDefined();
  });

  it('refuses a collection naming a step that does not exist', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', loop: { over: '{{steps.ghost.rows}}' } },
    ])).toContain('UNADDRESSABLE_REF');
  });

  it('refuses an empty collection', () => {
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', loop: { over: '' } },
    ])).toContain('UNADDRESSABLE_REF');
  });
});

// `output` addressed as though it were the step registry.
//
// The subtle half of the same defect, and the reason the existing rule could
// not have caught it: `output` IS a readable root, so every root check passes.
// It is bound to the PREVIOUS step's output, so `output.s13.cards_to_update`
// walks s13's own output looking for a key called "s13".
describe('output.<existingStepId>', () => {
  it('is refused in a loop collection', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's13', type: 'llm_reason', onSuccess: 's14' } as never,
      { stepId: 's14', type: 'tool_call', toolName: 't', loop: { over: 'output.s13.cards_to_update' } },
    ]);
    const hit = problems.find((p) => p.message.includes('steps.s13.cards_to_update'));
    expect(hit?.code).toBe('UNADDRESSABLE_REF');
    expect(hit?.stepId).toBe('s14');
    expect(hit?.field).toBe('loop');
  });

  it('is refused in a tool template', () => {
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
      { stepId: 's2', type: 'tool_call', toolName: 't', toolInputTemplate: '{"rows":{{output.s1.rows}}}' },
    ]);
    const hit = problems.find((p) => p.message.includes('steps.s1.rows'));
    expect(hit?.code).toBe('UNADDRESSABLE_REF');
    expect(hit?.field).toBe('toolInputTemplate');
  });

  it('says nothing about an output path that names no step', () => {
    // Only a segment that IS another step's id is evidence the author meant
    // the registry. A step's own output does not carry a key equal to another
    // step's id, which is what makes the rule nearly false-positive-free.
    expect(codes([
      { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
      { stepId: 's2', type: 'tool_call', toolName: 't', loop: { over: 'output.plan.channels' } },
    ])).toEqual([]);
  });
});

// The root sets and the loop grammar here are a DELIBERATE DUPLICATE of the
// Tenant Runtime's, because this is a separate service and cannot import that
// module. What the duplicate is worth depends entirely on it staying true, so
// the decisions are pinned here as data rather than left to the comment beside
// them.
//
// Counterparts, all in the Tenant Runtime:
//   CONDITION_ROOTS         agent-execution/validate-workflow-graph.ts
//   TEMPLATE_VAR_RE         agent-execution/template.ts
//   TEMPLATE_VAR_ANCHORED   agent-execution/template.ts
//   loopCollectionRef       agent-execution/template.ts
describe('the roots this gate believes the runtime has', () => {
  // Two steps, so `steps.s1` names a real one: the root sets are what is under
  // test here, not the step-id check that rides alongside them.
  const t = (over: string) => codes([
    { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
    { stepId: 's2', type: 'tool_call', toolName: 't', loop: { over } },
  ]);
  const c = (condition: string) => codes([
    { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
    { stepId: 's2', type: 'tool_call', toolName: 't', condition, onFailure: 's1' },
  ]);
  const tpl = (toolInputTemplate: string) => codes([
    { stepId: 's1', type: 'tool_call', toolName: 't', onSuccess: 's2' },
    { stepId: 's2', type: 'tool_call', toolName: 't', toolInputTemplate },
  ]);

  it('a condition reads input, steps and item, and nothing else', () => {
    for (const root of ['input', 'steps', 'item']) {
      expect(c(`$.${root}.s1 == 'y'`)).toEqual([]);
    }
    // `output` is NOT a condition root, which is why D3 needed no condition
    // rule: `output.…` there is already reported as an invalid root.
    expect(c("$.output.x == 'y'")).toContain('UNADDRESSABLE_REF');
    expect(c("$.now.iso == 'y'")).toContain('UNADDRESSABLE_REF');
  });

  it('a template reads input, output, steps and item, and nothing else', () => {
    for (const root of ['input', 'steps', 'item']) {
      expect(tpl(`{"v":"{{${root}.s1}}"}`)).toEqual([]);
    }
    // `output` is a root here too. `{{output.s1}}` is not tested as legal
    // because it is the one shape the rule below refuses.
    expect(tpl('{"v":"{{output.rows}}"}')).toEqual([]);
    expect(tpl('{"v":"{{now.iso}}"}')).toContain('UNADDRESSABLE_REF');
  });

  it('a loop collection reads the same four roots, or a bare path', () => {
    for (const root of ['input', 'steps', 'item']) {
      expect(t(`${root}.s1`)).toEqual([]);
      expect(t(`{{${root}.s1}}`)).toEqual([]);
    }
    // `output` is a root here too, but `output.s1` is the one shape the rule
    // below refuses: a legal root addressed as though it were the registry.
    expect(t('output.rows')).toEqual([]);
    expect(t('{{output.rows}}')).toEqual([]);
    expect(t('items')).toEqual([]);
    expect(t('a.b.c')).toEqual([]);
    expect(t('{{now.iso}}')).toContain('UNADDRESSABLE_REF');
  });

  it('the new rule is reported under UNADDRESSABLE_REF, with `loop` as the field', () => {
    // The patch rung decides what a repair may touch from `code` and `field`,
    // never from the message. `loop` is admitted by no rung, so an unrepairable
    // loop makes the scope ineligible and falls through to the full retry.
    const problems = findWorkflowStepProblems([
      { stepId: 's1', type: 'tool_call', toolName: 't', loop: { over: '{{now.iso}}' } },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('UNADDRESSABLE_REF');
    expect(problems[0].field).toBe('loop');
  });
});
