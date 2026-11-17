// Every engine that CAN end a terminal round does, and none ends a silent one.
//
// A run that has posted the review and opened the thread is finished, and the
// loop still makes one model call to write a sentence saying so. Each engine
// closes it differently — a `toolUseBehavior` function on the OpenAI wire, a
// `PostToolBatch` hook on Claude, simply not taking the next iteration on Gemini
// where we own the loop — so the shared part is the DECISION, and this asserts
// the decision rather than three mechanisms.
//
// The plan named a mechanism for two of these that does not do the job:
// `stopAtToolNames` stops at the FIRST listed tool called, whatever else the
// round was doing, and makes that tool's raw output the run's final output. The
// hook's `PostToolBatchHookSpecificOutput` carries only `additionalContext` and
// cannot stop anything — `continue: false` on the common output does. A
// mechanism existing is not a mechanism doing the thing.
import { roundIsTerminal, terminalToolNames } from '../../terminal-tools';

describe('the shared turn-closing decision', () => {
  const graph = [
    { stepId: 's1', description: '', toolName: 'github__pull_request_read', onSuccess: 's2' },
    { stepId: 's2', description: '', toolName: 'github__pull_request_review_write', onSuccess: 's3' },
    { stepId: 's3', description: '', toolName: 'liftoff__open_chat_thread' },
  ] as never;

  const terminal = terminalToolNames(graph);

  it('ends a round that called only the tool the graph ends at', () => {
    expect(roundIsTerminal(['liftoff__open_chat_thread'], terminal)).toBe(true);
  });

  it('does NOT end a round still doing other work', () => {
    // The guard. A round that opened the thread and read another pull request is
    // mid-plan; ending it truncates the run.
    expect(roundIsTerminal(['liftoff__open_chat_thread', 'github__pull_request_read'], terminal))
      .toBe(false);
  });

  it('does not end a run for an agent with no graph', () => {
    // A conversational agent has no terminal step, so nothing can say when it is
    // done, and every engine keeps today's behaviour.
    expect(roundIsTerminal(['anything'], terminalToolNames(undefined))).toBe(false);
  });

  it('treats a mid-graph tool as non-terminal even when it is the only call', () => {
    expect(roundIsTerminal(['github__pull_request_review_write'], terminal)).toBe(false);
  });
});

// The silent-turn guard, asserted at the seam each adapter reads.
//
// Ending a turn that has said nothing leaves an empty reply where the closing
// sentence would have been — a blank bubble in an interactive thread, which this
// estate has shipped before and which is worse than the model call it saves.
describe('the silent-turn guard', () => {
  it('is what each adapter checks before closing', () => {
    const sources = [
      'openai-wire/index.ts',
      'anthropic/index.ts',
      'gemini/index.ts',
    ].map((f) => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8'));

    // openai-wire gates on hasSpoken(), anthropic on this.hasStreamedText,
    // gemini on fullText.length — three spellings of one property, each read in
    // the same breath as roundIsTerminal.
    const [wire, anthropic, gemini] = sources;
    expect(wire).toMatch(/hasSpoken\(\)/);
    expect(anthropic).toMatch(/this\.hasStreamedText/);
    expect(gemini).toMatch(/fullText\.length > 0 && roundIsTerminal/);
  });
});
