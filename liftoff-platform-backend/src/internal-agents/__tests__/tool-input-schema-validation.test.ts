// A step's ARGUMENTS must be able to satisfy the tool it calls.
//
// The distiller validated a tool's NAME and the graph's WIRING and never
// checked that `toolInputTemplate` could satisfy the tool. So a generated agent
// shipped templates no call would accept, and the failure surfaced at run
// time as one MCP validation error per step — after which the agent,
// seeing its tools fail, narrated those failures as findings and escalated.
//
// The fixture below is a stored graph in which all four connector steps are
// wrong:
//
//   get_thread       sent thread_id            missing user_id
//   list_messages    sent q, max_results       missing user_id; q not a property
//   reply_to_thread  sent thread_id/from/body  missing user_id, message_body
//   mark_as_read     sent id                   needs thread_id + user_id

import { __internalValidateWorkflowSteps as validateWorkflowSteps, type ToolCatalog } from '../distill-service';
import { validateToolArgs, parseAuthoredArgs } from '../tool-arg-validation';

const GMAIL = 'google-mail-14a82d9e';

const catalog: ToolCatalog = new Map([
  [`${GMAIL}__get_thread`, {
    name: `${GMAIL}__get_thread`, description: 'read a thread',
    input_schema: { type: 'object', properties: { user_id: {}, thread_id: {} }, required: ['user_id', 'thread_id'] },
  }],
  [`${GMAIL}__mark_as_read`, {
    name: `${GMAIL}__mark_as_read`, description: 'ack',
    input_schema: {
      type: 'object',
      properties: { user_id: {}, thread_id: {}, add_label_ids: {}, remove_label_ids: {} },
      required: ['user_id', 'thread_id'],
    },
  }],
]);

const step = (o: Record<string, unknown>) => ({ description: 'd', type: 'tool_call', ...o } as never);

describe('arguments that do not match the tool schema', () => {
  it('catches mark_as_read sending {id} when it needs thread_id + user_id', () => {
    const errs = validateWorkflowSteps(
      [step({ stepId: 's12', toolName: `${GMAIL}__mark_as_read`, toolInputTemplate: '{"id":"{{input.message.threadId}}"}' })],
      catalog,
    );
    const e = errs.find((x) => x.type === 'tool_input_mismatch');
    expect(e).toBeDefined();
    expect(e!.detail).toContain('MISSING required: user_id, thread_id');
    expect(e!.detail).toContain('NOT a parameter: id');
    // The correction must name what IS accepted, or the retry has nothing to
    // converge on — the same lesson as the truncated unknown_tool feedback.
    expect(e!.detail).toContain('The tool accepts:');
  });

  it('catches a missing required parameter even when every key sent is valid', () => {
    const errs = validateWorkflowSteps(
      [step({ stepId: 's1', toolName: `${GMAIL}__get_thread`, toolInputTemplate: '{"thread_id":"{{input.message.threadId}}"}' })],
      catalog,
    );
    const e = errs.find((x) => x.type === 'tool_input_mismatch');
    expect(e!.detail).toContain('MISSING required: user_id');
    expect(e!.detail).not.toContain('NOT a parameter');
  });

  it('accepts a template that satisfies the schema', () => {
    const errs = validateWorkflowSteps(
      [step({ stepId: 's1', toolName: `${GMAIL}__get_thread`, toolInputTemplate: '{"user_id":"me","thread_id":"{{input.message.threadId}}"}' })],
      catalog,
    );
    expect(errs.filter((x) => x.type === 'tool_input_mismatch')).toEqual([]);
  });
});

describe('what it deliberately does not do', () => {
  it('says nothing when the tool has no recorded schema', () => {
    // Platform tools, and any catalog predating the input_schema forwarding.
    // Silence, never a guess.
    const noSchema: ToolCatalog = new Map([['x__y', { name: 'x__y', description: '' }]]);
    const errs = validateWorkflowSteps(
      [step({ stepId: 's1', toolName: 'x__y', toolInputTemplate: '{"anything":"1"}' })],
      noSchema,
    );
    expect(errs.filter((x) => x.type === 'tool_input_mismatch')).toEqual([]);
  });

  it('does not double-report a malformed template', () => {
    // Broken JSON is the template check's finding, not this one's.
    const errs = validateWorkflowSteps(
      [step({ stepId: 's1', toolName: `${GMAIL}__get_thread`, toolInputTemplate: '{"thread_id":' })],
      catalog,
    );
    expect(errs.filter((x) => x.type === 'tool_input_mismatch')).toEqual([]);
  });

  it('reads placeholders as values, not as text', () => {
    // The template is JSON once {{…}} is neutralised; matching its text would
    // mistake a placeholder containing a colon for a key.
    const errs = validateWorkflowSteps(
      [step({ stepId: 's1', toolName: `${GMAIL}__get_thread`, toolInputTemplate: '{"user_id":"me","thread_id":"{{steps.s2.a:b}}"}' })],
      catalog,
    );
    expect(errs.filter((x) => x.type === 'tool_input_mismatch')).toEqual([]);
  });
});

// The two defences this file's check depends on were both off for platform tools.
//
// The prompt renders a tool as `name(required*, optional)` when it has a schema
// and as bare `name: description` when it does not. The check below skips a
// tool with no schema outright. `PLATFORM_RELIABILITY_TOOLS` were written into
// the catalog carrying only name/description/categories, so both mechanisms
// silently no-opped for exactly the tools no manifest describes and whose
// arguments a graph author must write by hand.
//
// A call to `have_i_acted_on` that omits its required `target` means the
// duplicate-work guard the graph relies on never runs, and a redistill can
// reproduce the omission and add another.
describe('platform tools are checkable too', () => {
  const platform: ToolCatalog = new Map([
    ['have_i_acted_on', {
      name: 'have_i_acted_on', description: 'dedupe',
      input_schema: {
        type: 'object',
        properties: { connector: {}, target: {}, version: {}, action: {}, scope: {}, window_days: {} },
        required: ['connector', 'target'],
      },
    }],
  ]);

  it('catches the shape every stored call has used', () => {
    const errors = validateWorkflowSteps([
      {
        stepId: 's1b', type: 'tool_call', description: 'dedupe check',
        toolName: 'have_i_acted_on',
        toolInput: { connector: 'google_docs', action: 'update_document_markdown', document_id: '1ISydz' },
      },
    ] as never, platform);

    const mismatch = errors.filter((e) => e.type === 'tool_input_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].detail).toContain('MISSING required: target');
    // The keys it reached for instead, so the author sees the swap.
    expect(mismatch[0].detail).toContain('NOT a parameter');
  });

  it('reads a literal toolInput, not only a template', () => {
    // The field the whole class was authored in, and the one never inspected.
    const viaTemplate = validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInputTemplate: '{"connector":"google_docs"}',
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch');
    const viaLiteral = validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInput: { connector: 'google_docs' },
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch');

    expect(viaTemplate).toHaveLength(1);
    expect(viaLiteral).toHaveLength(1);
    expect(viaLiteral[0].detail).toContain('MISSING required: target');
  });

  it('accepts a call that supplies the target', () => {
    expect(validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInput: { connector: 'github', target: { owner: 'o', repo: 'r', pull_number: 1 } },
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
  });

  it('still says nothing about a tool whose schema is genuinely unknown', () => {
    // The skip is right when there is no schema; it was wrong only because the
    // platform family had none to begin with.
    const noSchema: ToolCatalog = new Map([['mystery', { name: 'mystery', description: 'x' }]]);
    expect(validateWorkflowSteps([
      { stepId: 's1', type: 'tool_call', description: 'd', toolName: 'mystery', toolInput: { anything: 1 } },
    ] as never, noSchema).filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
  });
});

// Presence is not shape.
//
// With the schema forwarded, a redistill can supply `target` — as a string
// holding a document id, for a parameter declared `object`. Every required key
// is present, the presence check passes, and the tool rejects the call exactly
// as it would if the key were missing altogether. The argument has moved from
// absent to wrong, which is invisible in the same way.
describe('a value of the wrong shape', () => {
  const platform: ToolCatalog = new Map([
    ['have_i_acted_on', {
      name: 'have_i_acted_on', description: 'dedupe',
      input_schema: {
        type: 'object',
        properties: {
          connector: { type: 'string' }, target: { type: 'object' },
          action: { type: 'string' }, window_days: { type: 'number' },
        },
        required: ['connector', 'target'],
      },
    }],
  ]);

  const mismatches = (toolInput: Record<string, unknown>) =>
    validateWorkflowSteps([
      { stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on', toolInput },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch');

  it('catches a string where an object is declared', () => {
    const errs = mismatches({
      connector: 'google_docs', target: '1ISydz', action: 'update_document_markdown', window_days: 10,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0].detail).toContain('WRONG type: target must be an object');
    // Not reported as absent, because it is not.
    expect(errs[0].detail).not.toContain('MISSING required');
  });

  it('accepts the object form', () => {
    expect(mismatches({ connector: 'google_docs', target: { document_id: '1ISydz' } })).toEqual([]);
  });

  it('does not judge a placeholder, which carries no type', () => {
    // `"target":"{{steps.s1.x}}"` is a string in the template text whatever it
    // resolves to. Flagging it would refuse the correct authoring.
    expect(validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInputTemplate: '{"connector":"google_docs","target":"{{steps.s1.ref}}"}',
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
  });

  it('DOES judge a literal inside a template', () => {
    // Where the next wrong one appeared, once the literal form was closed: raw
    // text in the template, no placeholder, so nothing about it is unknowable.
    const errs = validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInputTemplate:
          '{"connector":"google_docs","action":"update_document_markdown","target":"1ISydz_W62ij"}',
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch');
    expect(errs).toHaveLength(1);
    expect(errs[0].detail).toContain('WRONG type: target must be an object');
  });

  it('accepts an object built inside a template', () => {
    expect(validateWorkflowSteps([
      {
        stepId: 's1', type: 'tool_call', description: 'd', toolName: 'have_i_acted_on',
        toolInputTemplate: '{"connector":"google_docs","target":{"document_id":"{{input.doc}}"}}',
      },
    ] as never, platform).filter((e) => e.type === 'tool_input_mismatch')).toEqual([]);
  });

  it('checks scalars too, which the hand-rolled version could not', () => {
    // Not a widening for its own sake: `window_days` as a string is the same
    // class of defect as `target` as a string, and the only reason it used to
    // pass is that a reimplementation covers what its author thought of.
    const errs = mismatches({ connector: 'google_docs', target: { id: 'x' }, window_days: 'ten' });
    expect(errs).toHaveLength(1);
    expect(errs[0].detail).toContain('WRONG type: window_days must be a number');
  });

  it('repairs a numeric string where a number is declared, rather than rejecting it', () => {
    // The value is right and only its JSON type is wrong. That is the one
    // class the lossless coercion (tool-arg-validation.ts, coerceToolArgs)
    // repairs in place before the judgment, so it no longer costs a retry.
    expect(mismatches({ connector: 'google_docs', target: { id: 'x' }, window_days: '10' })).toEqual([]);
  });
});

// A shape the distiller actually authors: both placeholder forms in one template.
//
// `{"path": "{{item.path}}", "line": {{item.line}}}` has one placeholder inside
// a string and one bare in a value position. Substituting uniformly cannot parse
// it either way — leave the bare one unquoted and the JSON is invalid, quote them
// all and the in-string one becomes `""{{P}}""`. Templated connector steps
// commonly take that shape, and skipping them in silence is the safe
// direction, and still blind.
describe('a template mixing quoted and bare placeholders', () => {
  const MIXED = '{"path": "{{item.path}}", "line": {{item.line}}, "subjectType": "LINE", "body": "{{item.body}}"}';

  it('parses, where a uniform substitution cannot', () => {
    const parsed = parseAuthoredArgs(MIXED) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(Object.keys(parsed).sort()).toEqual(['body', 'line', 'path', 'subjectType']);
  });

  it('keeps every placeholder visible so the validator can exempt it', () => {
    const parsed = parseAuthoredArgs(MIXED) as Record<string, string>;
    expect(parsed.path).toContain('{{');
    expect(parsed.line).toContain('{{');
    // The one real literal survives as itself, and is judged.
    expect(parsed.subjectType).toBe('LINE');
  });

  it('exempts the placeholders and still judges the literal beside them', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' }, line: { type: 'number' },
        subjectType: { type: 'string' }, body: { type: 'string' },
      },
      required: ['path', 'line'],
    };
    // `line` is a number in the schema and a placeholder here: exempt, not wrong.
    expect(validateToolArgs(schema, parseAuthoredArgs(MIXED))).toEqual([]);
    // The same template with a literal of the wrong type IS caught.
    const wrong = '{"path": "{{item.path}}", "line": "not-a-number", "subjectType": "LINE"}';
    const problems = validateToolArgs(schema, parseAuthoredArgs(wrong));
    expect(problems.map((p) => p.message).join(' ')).toContain('line must be a number');
  });

  it('returns undefined for JSON no substitution can rescue', () => {
    expect(parseAuthoredArgs('{"connector":')).toBeUndefined();
  });
});
