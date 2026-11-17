// Every rule a fence enforces is stated somewhere the model reads BEFORE it
// authors the graph.
//
// Two of the most common rejection classes are
// `tool_call_without_failure_edge` and `unsafe_customer_copy`. A rule that
// appears in neither the schema nor the prompt is met only as feedback, each
// time costing a whole attempt, and a toolInputTemplate description that
// shows the splice the copy fence rejects actively teaches it. This test holds the authored surfaces to the fences: a fence
// that gains a rule without stating it here is the shape that fails.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  __internalGetProduceAgentToolText,
  __internalGetPromptText,
  buildObligationsSection,
} from '../distill-service';

describe('the produce_agent schema states the graph rules the fences enforce', () => {
  const tool = JSON.parse(__internalGetProduceAgentToolText()) as {
    input_schema: { properties: { workflowSteps: { items: { oneOf: Array<{ properties: Record<string, { description?: string }> }> } } } };
  };
  // The tool_call variant is the one with a toolInputTemplate.
  const step = tool.input_schema.properties.workflowSteps.items.oneOf
    .map((v) => v.properties)
    .find((p) => p.toolInputTemplate && p.onFailure)!;

  it('onFailure is required on every non-terminal tool_call, not only as the else branch', () => {
    expect(step.onFailure.description).toMatch(/REQUIRED ON EVERY tool_call THAT HAS AN onSuccess/);
    expect(step.onFailure.description).toMatch(/ELSE BRANCH OF `condition`/);
  });

  it('a person-read prose field is one whole placeholder or literal text, with no em dash', () => {
    const d = step.toolInputTemplate.description ?? '';
    expect(d).toMatch(/PROSE A PERSON READS IS EITHER ONE WHOLE PLACEHOLDER OR LITERAL TEXT/);
    for (const key of ['body', 'subject', 'title', 'text', 'content', 'message_body', 'html_body']) {
      expect(d).toContain(`\`${key}\``);
    }
    expect(d).toContain('open_chat_thread');
    expect(d).toMatch(/never contains an em dash/);
  });

  it('no longer teaches the splice the copy fence rejects', () => {
    // The two examples that used to sit in this description were notification
    // bodies with a step field spliced into a sentence — exactly what
    // findUnsafeCustomerFacingCopy rejects on an outbound body.
    const d = step.toolInputTemplate.description ?? '';
    expect(d).not.toContain('"Review ready for {{steps.s1.repo}}.');
    expect(d).not.toContain('("Ready for {{steps.s1.repo}}#{{steps.s1.number}}")');
  });
});

describe('the system prompt states the scripted-copy voice rule', () => {
  it('quoted copy is sent as written: no em dash, never "agent" or "bot" in front of a person', () => {
    const prompt = __internalGetPromptText();
    expect(prompt).toContain('### Quoted copy is sent as written');
    expect(prompt).toMatch(/no em dash/);
    expect(prompt).toMatch(/never calls itself an agent, a bot, or automated/);
  });
});

describe('the template\'s obligations are stated before the graph is authored', () => {
  it('names each declared obligation, and the two graph-wide rules, once', () => {
    const text = buildObligationsSection({
      requiresIdempotencyCheck: true,
      requiresChatThreadStep: true,
      producesDocument: true,
      comparesWithLastRun: true,
      writesRequireProvenance: true,
    });
    expect(text).toContain('`have_i_acted_on` BEFORE the step that acts');
    expect(text).toContain('`open_chat_thread`');
    expect(text).toContain('The deliverable is a file');
    expect(text).toContain("write this run's record");
    expect(text).toContain('precedes any write');
    expect(text).toContain('every non-terminal tool_call sets onFailure');
  });

  it('says nothing when the template declares nothing', () => {
    expect(buildObligationsSection({
      requiresIdempotencyCheck: false,
      requiresChatThreadStep: false,
      producesDocument: false,
      comparesWithLastRun: false,
      writesRequireProvenance: false,
    })).toBe('');
  });

  it('states only the obligations declared', () => {
    const text = buildObligationsSection({
      requiresIdempotencyCheck: true,
      requiresChatThreadStep: false,
      producesDocument: false,
      comparesWithLastRun: false,
      writesRequireProvenance: false,
    });
    expect(text).toContain('`have_i_acted_on`');
    expect(text).not.toContain('`open_chat_thread`');
    expect(text).not.toContain('The deliverable is a file');
  });
});
