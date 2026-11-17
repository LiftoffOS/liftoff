// A distill retry must edit the graph it just produced, not re-author one blind.
//
// The retry channel used to push the validation errors ALONE — no assistant
// turn. The model was told `- Step "s2": MISSING required: user_id` about an
// artifact it could not see, so with nothing to edit it re-wrote all twelve
// steps from scratch every attempt. Retries did not converge; they were
// independent samples that happened to know which faces came up last time.
//
// A typical sequence:
//   attempt 1  s1 s2 s6 s7 s8 s10 bad
//   attempt 2  those fixed — s3 and s6 now bad
//   attempt 3  those fixed — s2 and s10 back to attempt 1's exact mistakes
// Three attempts, zero progress, `workflowSteps: null`, a live agent left with
// no graph. Raising MAX_RETRIES cannot fix a process that does not converge.
//
// Source-level for the same reason as distill-capability-truth.test.ts: the real
// module drags in proto-gen, which does not resolve inside a worktree.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

const retryBlock = SRC.slice(
  SRC.indexOf('if (validationFeedback && lastAttempt) {'),
  SRC.indexOf('// Hybrid execution engine: only produce_agent is offered.'),
);

describe('the retry replays the model its own artifact', () => {
  it('has a block to assert against', () => {
    expect(retryBlock.length).toBeGreaterThan(200);
  });

  it('sends an assistant tool_use turn carrying the previous input', () => {
    // This is the provider-native correction shape. Every adapter in src/llm
    // maps `toolCalls` on an assistant turn (anthropic-shared.ts, openai.ts,
    // google.ts), so this reaches the model rather than being dropped.
    expect(retryBlock).toContain("role: 'assistant'");
    expect(retryBlock).toContain('toolCalls: [{');
    expect(retryBlock).toContain('input: lastAttempt.input');
    expect(retryBlock).toContain("name: 'produce_agent'");
  });

  it('keys the errors to that call as a tool_result', () => {
    expect(retryBlock).toContain('toolResults: [{');
    expect(retryBlock).toContain('toolCallId: lastAttempt.toolCallId');
  });

  it('tells the model to preserve the steps the errors do not name', () => {
    // Without this the model is free to "improve" accepted steps, which is the
    // regression half of the whack-a-mole above.
    expect(retryBlock).toMatch(/reproduce it unchanged/i);
    expect(retryBlock).toMatch(/Do not rewrite, renumber or re-plan/i);
    expect(retryBlock).toMatch(/ONLY the errors listed/i);
  });

  it('still clears the feedback so an attempt reports only its own failures', () => {
    expect(retryBlock).toContain('validationFeedback = null;');
  });

  it('falls back to a plain complaint when there is no artifact to correct', () => {
    // An attempt can fail before or during the tool call — no parsed input to
    // replay. That must still retry, not crash or silently skip the feedback.
    expect(retryBlock).toContain('} else if (validationFeedback) {');
    expect(retryBlock).toContain('Your previous response had validation errors');
  });
});

describe('the replayed artifact is the one the errors describe', () => {
  it('captures after normalization, not the raw tool input', () => {
    // Validation runs against the normalized artifact: its step ids are the ones
    // the feedback names. Replaying the raw input would hand the model back the
    // shape defects normalizeDistillOutput had already repaired, inviting it to
    // reproduce them.
    const capture = SRC.slice(
      SRC.indexOf('const toolInput = normalizeDistillOutput('),
      SRC.indexOf('lastAttempt = { toolCallId: toolCall.id, input: toolInput };') + 80,
    );
    expect(capture).toContain('lastAttempt = { toolCallId: toolCall.id, input: toolInput };');
    expect(capture).not.toContain('input: toolCall.input');
  });

  it('captures on every attempt, before any validator runs', () => {
    // If the capture sat after validation it would only ever record a graph that
    // had already passed — i.e. never the one needing correction.
    const capturedAt = SRC.indexOf('lastAttempt = { toolCallId: toolCall.id');
    // The validators are one closure now (the patch rung runs it twice); the
    // first thing that runs it is this line.
    const firstValidator = SRC.indexOf('let validationErrors = collectGraphErrors(workflowSteps);');
    expect(capturedAt).toBeGreaterThan(-1);
    expect(firstValidator).toBeGreaterThan(capturedAt);
  });
});
