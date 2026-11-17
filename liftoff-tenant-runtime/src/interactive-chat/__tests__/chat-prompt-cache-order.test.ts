// The chat prompt puts what changes every turn AFTER what never changes.
//
// Prompt caching pays only on a byte-identical prefix, so one volatile block
// placed early invalidates every stable block after it. `prompt-tiers.ts` was
// written for exactly this, and its header names the exact shape: static
// directives "appended AFTER the retrieved memories and the prior-run summary,
// which change every turn".
//
// The autonomous path was fixed. This one was not, and it is the busier of the
// two — chat sets `systemPromptOverride`, so `buildSystemPrompt` returns early
// and the tiered assembly never runs for a chat turn at all. Memory and the
// prior-run summary sat above the document-generation and citation blocks, which
// are identical on every run of every agent, so those re-sent uncached forever.
import { buildAgentChatSystemPrompt } from '../system-prompt';

const base = {
  agent: {
    role: 'Analyst',
    messagingNickname: 'Ada',
    systemPrompt: 'Be precise.',
    userInstructions: null,
  },
  user: { displayName: 'Alex', role: 'owner' },
  connectorList: '- gmail',
} as never;

const build = (extra: Record<string, unknown>) =>
  buildAgentChatSystemPrompt({ ...(base as object), ...extra } as never);

describe('cache ordering in the chat system prompt', () => {
  const MEMORY = 'REMEMBERED_FACT_MARKER';
  const PRIOR = '<prior_run>PRIOR_RUN_MARKER</prior_run>';

  it('puts memory and the prior run below the static blocks', () => {
    const prompt = build({ memoryBlock: MEMORY, priorInvocationSummary: PRIOR });

    const memoryAt = prompt.indexOf(MEMORY);
    const priorAt = prompt.indexOf(PRIOR);
    const capabilitiesAt = prompt.indexOf('## Your Capabilities');

    expect(memoryAt).toBeGreaterThan(-1);
    expect(priorAt).toBeGreaterThan(-1);
    // Everything static comes first, so the prefix survives them.
    expect(memoryAt).toBeGreaterThan(capabilitiesAt);
    expect(priorAt).toBeGreaterThan(capabilitiesAt);
  });

  it('keeps the final reminders last, after the volatile blocks', () => {
    // Its position IS its purpose — a recency argument rather than a category
    // one — so it pays the cache cost knowingly instead of by accident.
    const prompt = build({ memoryBlock: MEMORY, priorInvocationSummary: PRIOR });
    expect(prompt.indexOf('## Final reminders')).toBeGreaterThan(prompt.indexOf(MEMORY));
  });

  it('is byte-identical across two assemblies of the same inputs', () => {
    const args = { memoryBlock: MEMORY, priorInvocationSummary: PRIOR };
    expect(build(args)).toBe(build(args));
  });

  it('leaves the static prefix unchanged when only the volatile blocks differ', () => {
    // The property caching actually needs: two turns of one conversation share
    // every byte up to the first volatile block.
    const a = build({ memoryBlock: 'ONE', priorInvocationSummary: '<p>1</p>' });
    const b = build({ memoryBlock: 'TWO', priorInvocationSummary: '<p>2</p>' });
    const shared = a.slice(0, a.indexOf('ONE'));
    expect(b.startsWith(shared)).toBe(true);
    expect(shared.length).toBeGreaterThan(200);
  });
});
