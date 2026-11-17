// The prompt-cache routing key, and the two ways it silently stops working.
//
// OpenAI routes a request to a cache by `prompt_cache_key` plus a hash of the
// prompt prefix. The key does not MAKE a hit — the prefix still has to match
// byte for byte — it decides which cache is consulted. So the failure mode is
// not an error: a key that varies per run routes every run to a fresh shard,
// every first turn misses, and the only symptom is a cache-hit rate that looks
// like the prefix is unstable when it is perfectly stable.
//
// The other failure is the mirror image. Sending the parameter to an endpoint
// that does not carry it is at best ignored and at worst a 400 from api.x.ai,
// which refuses options it does not know.

import { openAiTarget } from '../../openai';
import { openRouterTarget } from '../../openrouter';
import { xaiTarget } from '../../xai';
import { agentPromptCacheKey, PROMPT_CACHE_KEY_MAX } from '../wire-target';
import type { InvocationInput } from '../../types';

function input(over: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [],
    systemPrompt: 'sys',
    model: 'gpt-5.4-mini',
    provider: 'openai',
    tenantId: 'tenant-a',
    agentId: 'agent-1',
    invocationId: 'inv-1',
    ...over,
  } as InvocationInput;
}

describe('the key groups runs by what they have in common', () => {
  it('is identical for two runs of one agent', () => {
    // The whole point. These two share a system prompt and a tool catalog, so
    // they are exactly the pair that should consult one cache.
    expect(agentPromptCacheKey(input({ invocationId: 'inv-1' })))
      .toBe(agentPromptCacheKey(input({ invocationId: 'inv-2' })));
  });

  it('does not vary with the invocation', () => {
    // Stated separately from the test above because this is the regression that
    // would be invisible: keying on invocationId reads as "a unique key per
    // request", which sounds correct and defeats the mechanism entirely.
    const key = agentPromptCacheKey(input({ invocationId: 'inv-99' }));
    expect(key).not.toContain('inv-99');
  });

  it('separates agents, and separates tenants', () => {
    const base = agentPromptCacheKey(input());
    expect(agentPromptCacheKey(input({ agentId: 'agent-2' }))).not.toBe(base);
    expect(agentPromptCacheKey(input({ tenantId: 'tenant-b' }))).not.toBe(base);
  });

  it('answers nothing rather than a partial key when identity is missing', () => {
    // A key of 'liftoff::agent-1' would silently merge every tenant with no id
    // into one cache lane.
    expect(agentPromptCacheKey(input({ tenantId: '' }))).toBeUndefined();
    expect(agentPromptCacheKey(input({ agentId: '' }))).toBeUndefined();
  });
});

describe('the key fits the endpoint', () => {
  it('is at most 64 characters for real UUID identities', () => {
    // OpenAI caps `prompt_cache_key` at 64 characters. Two UUIDs behind a
    // prefix are 81, and the endpoint answered every direct-OpenAI run with
    // `400 Invalid 'prompt_cache_key': string too long` — a validation failure
    // before the first model call, on every run, for as long as the key was
    // the ids themselves. The fixtures above use short ids and never saw it.
    const key = agentPromptCacheKey(input({
      tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      agentId: '70a549d8-4fe7-4586-923d-b08995c53566',
    }))!;
    expect(key.length).toBeLessThanOrEqual(PROMPT_CACHE_KEY_MAX);
    expect(key).toMatch(/^liftoff:[0-9a-f]+$/);
  });

  it('is still stable and still separates identities after the digest', () => {
    const a = agentPromptCacheKey(input({ tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd', agentId: '70a549d8-4fe7-4586-923d-b08995c53566' }));
    expect(agentPromptCacheKey(input({ tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd', agentId: '70a549d8-4fe7-4586-923d-b08995c53566', invocationId: 'other' }))).toBe(a);
    expect(agentPromptCacheKey(input({ tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd', agentId: 'c3dc3128-ca5f-443c-8572-f4fe4ab06d3e' }))).not.toBe(a);
  });
});

describe('the key can be switched off, so its effect can be measured', () => {
  // Not a safety valve first — a measurement instrument. Two benchmark runs at
  // different prompt sizes cannot separate "the key worked" from "the prompt
  // got longer", and only a fixed-prompt A/B can.
  afterEach(() => { delete process.env.PROMPT_CACHE_KEY_DISABLED; });

  it('answers nothing when disabled', () => {
    process.env.PROMPT_CACHE_KEY_DISABLED = '1';
    expect(agentPromptCacheKey(input())).toBeUndefined();
    expect(openAiTarget.promptCacheKey?.(input())).toBeUndefined();
  });

  it('is off only for the exact value, not for any truthy string', () => {
    // A half-set flag that silently disables caching would be worse than no
    // flag: the benchmark would read as a regression with nothing to point at.
    process.env.PROMPT_CACHE_KEY_DISABLED = 'false';
    expect(agentPromptCacheKey(input())).toMatch(/^liftoff:[0-9a-f]+$/);
  });
});

describe('only the endpoint that carries the parameter gets it', () => {
  it('OpenAI answers a key', () => {
    expect(openAiTarget.promptCacheKey?.(input())).toBe(agentPromptCacheKey(input()));
    expect(openAiTarget.promptCacheKey?.(input())).toMatch(/^liftoff:[0-9a-f]+$/);
  });

  it.each([
    ['openrouter', openRouterTarget],
    ['xai', xaiTarget],
  ])('%s answers none', (_name, target) => {
    // api.x.ai refuses options it does not know, and OpenRouter fans out to
    // whichever upstream is cheapest — there is no one cache behind it.
    expect(target.promptCacheKey?.(input())).toBeUndefined();
  });
});
