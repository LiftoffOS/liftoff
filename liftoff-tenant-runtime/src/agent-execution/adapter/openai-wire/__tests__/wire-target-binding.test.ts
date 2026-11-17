// Every OpenAI-wire target must BIND its model to the provider that serves it.
//
// This is the one property that cannot be read off a target in isolation, and
// the one whose absence is silent. A target that returns a bare string
// typechecks, passes its own tests, and then resolves the model against the
// SDK's DEFAULT OpenAI client at run time: a different endpoint, a different
// account's key, or — for a customer-funded run — Liftoff's account instead of
// the customer's. There is no per-call way to redirect that, because
// `modelProvider` belongs to RunConfig and only a Runner carries one.
//
// Enumerated by SHAPE rather than by a hand-written list, so a target added to
// any vendor module is covered the day it is written rather than the day someone
// remembers this file. The module list is asserted below, so a vendor added
// without being wired in here fails rather than going unchecked.

import * as openAiModule from '../../openai';
import * as openRouterModule from '../../openrouter';
import * as xaiModule from '../../xai';
import type { InvocationInput } from '../../types';
import type { WireTarget } from '../wire-target';

function isWireTarget(v: unknown): v is WireTarget {
  const t = v as Partial<WireTarget> | null;
  return !!t && typeof t === 'object'
    && typeof t.name === 'string'
    && typeof t.sdkProvider === 'function'
    && typeof t.modelId === 'function';
}

const targets: Array<[string, WireTarget]> = [openAiModule, openRouterModule, xaiModule]
  .flatMap(mod => Object.values(mod).filter(isWireTarget))
  .map(t => [t.name, t]);

/** A provider that records what it was asked to bind and hands back something
 *  that is provably not the id it was given. */
function fakeProvider() {
  const bound: string[] = [];
  return {
    bound,
    provider: {
      getModel: async (name?: string) => {
        bound.push(name ?? '');
        return { boundTo: name } as never;
      },
    } as unknown as Parameters<WireTarget['modelId']>[1],
  };
}

const input = { model: 'x-ai/grok-4.6', purpose: undefined } as unknown as InvocationInput;

describe('every wire target binds its model to its provider', () => {
  it('found the targets it is supposed to be checking', () => {
    // Guards the enumeration itself. If the targets move, this fails rather
    // than silently checking nothing — the failure mode of every test that
    // enumerates by shape.
    expect(targets.map(([n]) => n).sort()).toEqual(['openai', 'openrouter', 'xai']);
  });

  it.each(targets)('%s binds rather than returning a bare id', async (_name, target) => {
    const { provider, bound } = fakeProvider();
    const model = await target.modelId(input, provider);
    expect(typeof model).not.toBe('string');
    expect(bound).toHaveLength(1);
  });

  it.each(targets)('%s falls back to a bare id only when there is no provider', async (_name, target) => {
    // The one case a string is correct: no provider means "use the SDK's
    // default", which is a deliberate fallback rather than an oversight.
    const model = await target.modelId(input, undefined);
    expect(typeof model).toBe('string');
  });
});

describe('which hosted tools each endpoint offers', () => {
  // Web search is billed PER CALL by the endpoints that run it, so whether a
  // target offers it is a money question as well as a capability one.
  const grok = { model: 'grok-4.3' } as unknown as InvocationInput;
  const gpt5 = { model: 'gpt-5.4' } as unknown as InvocationInput;
  const gpt4o = { model: 'gpt-4o' } as unknown as InvocationInput;

  function target(name: string): WireTarget {
    const t = targets.find(([n]) => n === name)?.[1];
    if (!t) throw new Error(`no ${name} target`);
    return t;
  }

  it('xai offers its own web_search on every Grok model', () => {
    // api.x.ai serves web_search across the catalogue on the Responses
    // surface, so there is no model gate here to get wrong later.
    expect(target('xai').nativeWebTools(grok)).toHaveLength(1);
  });

  it('xai sends NO OpenAI-only arguments with it', () => {
    // `search_context_size` is the one that matters: the SDK's webSearchTool()
    // always sets it, and api.x.ai answers 400 "Argument not supported:
    // search_context_size". That is a failed model call, not a degraded
    // search — the step yields no output and no usage, and the run recovers
    // into a clarification instead of answering.
    const [t] = target('xai').nativeWebTools(grok);
    const provider = (t as { providerData?: Record<string, unknown> }).providerData ?? {};
    expect(provider).toEqual({ type: 'web_search' });
  });

  it('openai offers it only on the families that serve it', () => {
    expect(target('openai').nativeWebTools(gpt5)).toHaveLength(1);
    expect(target('openai').nativeWebTools(gpt4o)).toHaveLength(0);
  });

  it('openrouter offers none, and does not borrow OpenAI\'s model gate', () => {
    // It fronts five vendors over chat completions and runs no hosted tools.
    // An OpenAI-shaped id must not talk it into offering one.
    expect(target('openrouter').nativeWebTools(gpt5)).toHaveLength(0);
  });
});
