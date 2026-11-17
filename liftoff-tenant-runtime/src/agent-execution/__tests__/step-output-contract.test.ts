// The `outputField` contract, at the seam where it was unsatisfiable.
//
// WHY THESE EXIST. Every `outputField` test in this suite covered the
// `tool_call` path (`workflow-loop.test.ts` "outputField extraction",
// `hybrid-loop-integration.test.ts` T2). Not one covered `llm_reason`, and on
// that path the caller narrowed `getByPath(output, outputField)` over the
// adapter's JOINED ASSISTANT TEXT — a string, which getByPath rejects on its
// first hop. So an `llm_reason` step declaring `outputField` threw
// OutputShapeMismatchError on every run, in every commit, and the gap in this
// file is why nobody saw it: 45 such steps across all six production agents,
// four of which died on step 1.
//
// `record_step_output` is the channel that makes the contract satisfiable, and
// `readStepOutputReport` is the reader that recognises it off the adapter event
// stream. These tests pin the reader's rules directly, because that is the unit
// that decides whether a step produced its declared output or failed.

import { readStepOutputReport, STEP_OUTPUT_TOOL } from '../terminal-state';
import { getByPath } from '../get-by-path';

describe('readStepOutputReport — the llm_reason output channel', () => {
  it('reads the recorded object off the tool INPUT', () => {
    const args = { triage: { urgency: 'Low', first_name: 'Alex' } };
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, args, 'triage')).toEqual(args);
  });

  it('accepts the Anthropic MCP-namespaced tool name', () => {
    // Anthropic prefixes MCP tools; the bridge engines dispatch the bare name.
    // Both must be recognised or the contract silently fails on one engine —
    // the same rule readTaskOutcomeReport already follows.
    const args = { routing: { next: 'search-help' } };
    expect(
      readStepOutputReport('mcp__liftoff-tool-gateway__record_step_output', args, 'routing'),
    ).toEqual(args);
  });

  it('ignores any other tool call', () => {
    expect(readStepOutputReport('gmail__send', { triage: {} }, 'triage')).toBeNull();
  });

  it('returns null when the recorded object lacks the declared field', () => {
    // Null, not a partial object: registering a shape nobody declared is what
    // `outputField` exists to prevent, so a malformed report falls through to
    // the same OutputShapeMismatchError a missing call gets.
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, { somethingElse: 1 }, 'triage')).toBeNull();
  });

  it('requires only the ROOT segment of a dot-path outputField', () => {
    // The tool asks for the object the path is read from; getByPath walks the
    // remainder. A step declaring `customer.email` records `{customer: {...}}`.
    const args = { customer: { email: 'a@example.com' } };
    const recorded = readStepOutputReport(STEP_OUTPUT_TOOL, args, 'customer.email');
    expect(recorded).toEqual(args);
    expect(getByPath(recorded, 'customer.email')).toBe('a@example.com');
  });

  it('rejects a non-object payload', () => {
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, 'just text', 'triage')).toBeNull();
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, null, 'triage')).toBeNull();
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, [1, 2], 'triage')).toBeNull();
  });

  // Two ways the model writes the same value that left every downstream read
  // resolving to nothing while the record itself succeeded.
  it('reads a value written as JSON text as the value', () => {
    const args = { reddit: '{"posts": [{"title": "a"}], "count": 1}' };
    const recorded = readStepOutputReport(STEP_OUTPUT_TOOL, args, 'reddit')!;
    expect(getByPath(recorded, 'reddit.count')).toBe(1);
    expect(getByPath(recorded, 'reddit.posts')).toEqual([{ title: 'a' }]);
  });

  it('leaves a string that is not JSON as it is', () => {
    const args = { summary: 'nothing to report {yet}' };
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, args, 'summary')).toEqual(args);
  });

  it('unwraps a value wrapped once more under its own key', () => {
    const args = { digest: { digest: { digest_text: 'Weekly digest', post_at_epoch_seconds: '1' } } };
    const recorded = readStepOutputReport(STEP_OUTPUT_TOOL, args, 'digest')!;
    expect(getByPath(recorded, 'digest.digest_text')).toBe('Weekly digest');
  });

  it('does not unwrap when the key sits beside others', () => {
    // `digest` here is a real field of the record, not a wrapper.
    const args = { digest: { digest: 'text', post_at_epoch_seconds: '1' } };
    expect(readStepOutputReport(STEP_OUTPUT_TOOL, args, 'digest')).toEqual(args);
  });

  it('narrows to exactly what the next step reads', () => {
    // End to end at the unit level: what the step records, narrowed by the
    // declared field, is what `$.steps.<id>` resolves to downstream.
    const args = { routing: { next: 'search-help' } };
    const recorded = readStepOutputReport(STEP_OUTPUT_TOOL, args, 'routing')!;
    expect(getByPath(recorded, 'routing')).toEqual({ next: 'search-help' });
  });

  it('joined assistant text can never satisfy the contract — the original defect', () => {
    // Pinning the reason the channel had to exist at all. This is what
    // invokeStepLLM used to return for a step declaring `outputField`.
    expect(getByPath('The customer is asking how to create an agent.', 'triage')).toBeUndefined();
  });
});
