// A canonical record with no user turns is not a conversation.
//
// The recorder taps adapter OUTPUT events, so left to itself it captures only
// what the assistant said. Without the fix, a two-turn chat thread's
// canonical copy holds exactly two assistant messages and neither thing the
// user actually said.
//
// That matters because the canonical copy exists to let a conversation survive
// an engine change. Rebuilt from an assistant-only transcript, the next engine
// receives the agent's past answers with none of the questions: the model is
// handed itself talking into a void, which is worse than a cold start because
// it looks like context.
//
// The run path now records the current user turn immediately before invoking,
// so the array reads in conversation order. These tests pin the shape rather
// than the call site, so a future refactor that moves the recording still has
// to keep the property.

import { recordCanonicalMessage, snapshotCanonical, releaseBuffer } from '../recorder';

const INV = 'inv-user-turns';

afterEach(() => releaseBuffer(INV));

describe('the canonical record carries both sides', () => {
  it('keeps user and assistant turns in the order they happened', () => {
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'user', content: [{ type: 'text', text: 'remember ZEPHYRA' }],
    });
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'assistant', content: [{ type: 'text', text: 'ZEPHYRA' }],
    });
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'user', content: [{ type: 'text', text: 'what was the codeword?' }],
    });

    const snap = snapshotCanonical(INV);
    expect(snap).toBeDefined();
    expect(snap!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  // The regression this exists to catch. An assistant-only transcript passes
  // every count-based assertion — it has messages, it has content, it round
  // trips — while being useless for the one thing it is for.
  it('is not satisfied by assistant messages alone', () => {
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'assistant', content: [{ type: 'text', text: 'ZEPHYRA' }],
    });
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'assistant', content: [{ type: 'text', text: 'ZEPHYRB' }],
    });

    const snap = snapshotCanonical(INV);
    const roles = new Set(snap!.messages.map((m) => m.role));
    expect(roles.has('assistant')).toBe(true);
    // This is what dev actually had, and what a rebuild cannot use.
    expect(roles.has('user')).toBe(false);
  });

  it('drops an empty message rather than recording a turn that said nothing', () => {
    recordCanonicalMessage(INV, 'anthropic', 'claude-sonnet-4-6', {
      role: 'user', content: [],
    });
    expect(snapshotCanonical(INV)).toBeUndefined();
  });
});
