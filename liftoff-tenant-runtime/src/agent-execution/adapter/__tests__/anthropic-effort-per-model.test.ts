// The effort level the Claude Agent SDK adapter asks for, per model.
//
// WHY THIS HAS ITS OWN TEST. This is the path nearly every runtime token goes
// through, and it is invisible to the LLM-provider suites — those cover
// src/llm/providers/*, which the agent-execution adapter does not use. When the
// large tier moved from Opus 5 to Opus 5.5 the providers were updated and this
// call site was not, and nothing would have said so: the runs would simply have
// thought less, on every agent, indefinitely.
//
// The vendor default is what moved. Opus 5 defaulted to `high`; Opus 5.5
// defaults to `medium`. The adapter had one hardcoded 'medium' for every model,
// which was right for every model that had it and became wrong for exactly one
// — the new large model, where it would have bought LESS thinking than the model
// it replaced while the price went down. Pinning 'high' keeps the swap a change
// of price rather than a change of depth.
//
// 'medium' stays the answer for everything else, including a model this file
// has never heard of: it is the level every effort-capable model accepts (only
// 'max' is model-gated), so an unrecognised model gets the safe universal value
// rather than a guess.
//
// Asserted through the adapter's real call site rather than against the helper
// alone, because the helper being right and the call site not using it is
// exactly the failure this exists to catch.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(() => {
    const it = (async function* () { /* no messages */ })();
    return Object.assign(it, { interrupt: jest.fn(), setPermissionMode: jest.fn() });
  }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AnthropicAdapter, effortForModel } from '../anthropic';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput } from '../types';

function makeInput(model: string): InvocationInput {
  return {
    messages: [], systemPrompt: 's', model, provider: 'anthropic',
    tenantId: 't1', invocationId: 'inv1', maxTurns: 5,
  };
}

/** Drive the adapter far enough that query() has been called, and return the
 *  options it was handed. Post-stream behaviour is irrelevant here. */
async function optionsFor(model: string): Promise<Record<string, unknown>> {
  const adapter = new AnthropicAdapter();
  adapter.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
  try {
    for await (const _ of adapter.invoke(makeInput(model), new AbortController().signal)) { void _; }
  } catch { /* query() options are already captured */ }
  return (query as jest.Mock).mock.calls[0][0].options;
}

beforeEach(() => {
  (query as jest.Mock).mockClear();
});

describe('AnthropicAdapter — effort per model (call site)', () => {
  it('asks for high effort on Opus 5.5, whose vendor default is medium', async () => {
    const opts = await optionsFor('claude-opus-5-5');

    expect(opts.effort).toBe('high');
    // Adaptive thinking is unchanged and still required alongside it.
    expect(opts.thinking).toEqual({ type: 'adaptive' });
  });

  it('leaves Opus 5 on medium — its vendor default was already high', async () => {
    const opts = await optionsFor('claude-opus-5');

    expect(opts.effort).toBe('medium');
  });

  it('asks Sonnet 5.5 for medium, the level the medium tier ran at before the swap', async () => {
    // Deliberate, and the direction worth pinning: Sonnet 5.5's vendor default
    // is `high`, so this asks for LESS than the vendor would. `medium` is the
    // vendor's own recommendation for well-specified agentic and multistep tool
    // work, and it is what Sonnet 4.6 ran at on this path — so moving the tier
    // changes the model without also changing how hard it is asked to think.
    const opts = await optionsFor('claude-sonnet-5-5');

    expect(opts.effort).toBe('medium');
    // `between_tools` is not expressible through the Agent SDK at any version,
    // so this path stays on adaptive and its mid-loop prose stays unread.
    expect(opts.thinking).toEqual({ type: 'adaptive' });
  });

  it('gives an unrecognised model the safe universal level', async () => {
    const opts = await optionsFor('claude-something-not-released-yet');

    expect(opts.effort).toBe('medium');
  });
});

describe('effortForModel', () => {
  it('answers for every model the tiers can resolve to', () => {
    expect(effortForModel('claude-opus-5-5')).toBe('high');
    expect(effortForModel('claude-opus-5')).toBe('medium');
    expect(effortForModel('claude-sonnet-5-5')).toBe('medium');
    expect(effortForModel('claude-sonnet-5')).toBe('medium');
    expect(effortForModel('claude-haiku-4-5')).toBe('medium');
    expect(effortForModel(undefined)).toBe('medium');
  });
});
