// Which engines search natively, and which get the bridged `web_search`.
//
// One rule on every engine — the model vendor's own hosted search where the
// engine can attach it, the platform's bridged tool otherwise — so a model
// never sees two things called web search, and no engine is left with none.
// The answer is pinned per engine here because it decides what a run's tool
// catalog contains, and a wrong answer is silent both ways: a native search
// beside the bridged one is two tools with the same name; neither is an agent
// that cannot search at all and does not say so.

import { engineHasNativeWebSearch, nativeWebSearchFor } from '../native-web-search';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';
import type { ExecutionEngineId } from '../types';

/** The pinned answer per engine. A `Record` over the union so a new engine
 *  is a type error here — the exhaustive switch in the module is the runtime
 *  half of the same guarantee. */
const NATIVE: Record<Exclude<ExecutionEngineId, 'unknown-legacy'>, boolean> = {
  // Claude's WebSearch, attached default-on.
  'claude-agent-sdk': true,
  // Codex's web_search, pinned live.
  'openai-codex': true,
  // OpenAI's hosted web_search — on the Responses families only, asserted
  // separately below.
  'openai-agents': true,
  // xAI's hosted web_search, every Grok model.
  'xai-openai-wire': true,
  // Google Search grounding, and the CLI's google_web_search.
  'google-genai': true,
  'google-gemini-cli': true,
  // ADK attaches no grounding tool.
  'google-adk': false,
  // opencode attaches nothing of the vendor's; its own websearch is denied.
  opencode: false,
  // OpenRouter runs no hosted tools on our behalf.
  'openrouter-openai-wire': false,
};

describe('engineHasNativeWebSearch', () => {
  it('answers for every resolvable engine', () => {
    expect(Object.keys(NATIVE).sort()).toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
  });

  it.each(Object.entries(NATIVE) as Array<[ExecutionEngineId, boolean]>)(
    '%s searches natively: %s',
    (engine, expected) => {
      expect(engineHasNativeWebSearch(engine, 'gpt-5.4')).toBe(expected);
    },
  );

  it('on the Agents SDK bridge, only a Responses-API family carries OpenAI\'s search', () => {
    expect(engineHasNativeWebSearch('openai-agents', 'gpt-5.4')).toBe(true);
    expect(engineHasNativeWebSearch('openai-agents', 'o1-mini')).toBe(false);
  });

  it('offers nothing for the sentinel', () => {
    expect(engineHasNativeWebSearch('unknown-legacy', 'x')).toBe(false);
  });
});

describe('nativeWebSearchFor — the same answer for a run', () => {
  const saved: Record<string, string | undefined> = {};
  const FLAGS = ['OPENAI_ENGINE', 'XAI_ENGINE', 'OPENROUTER_ENGINE', 'GOOGLE_ENGINE'];
  beforeEach(() => { for (const f of FLAGS) { saved[f] = process.env[f]; delete process.env[f]; } });
  afterEach(() => { for (const f of FLAGS) { if (saved[f] === undefined) delete process.env[f]; else process.env[f] = saved[f]; } });

  it('follows the engine the provider resolves to on this service', () => {
    // Grok on opencode (the default) → bridged; on the wire → native.
    expect(nativeWebSearchFor('xai', 'grok-4.6')).toBe(false);
    process.env.XAI_ENGINE = 'wire';
    expect(nativeWebSearchFor('xai', 'grok-4.6')).toBe(true);
    // The open-weights families → bridged either way.
    expect(nativeWebSearchFor('glm', 'z-ai/glm-5.2')).toBe(false);
    process.env.OPENROUTER_ENGINE = 'wire';
    expect(nativeWebSearchFor('glm', 'z-ai/glm-5.2')).toBe(false);
    // OpenAI on Codex → native; on the bridge it depends on the model.
    expect(nativeWebSearchFor('openai', 'gpt-5.4')).toBe(true);
    process.env.OPENAI_ENGINE = 'agents';
    expect(nativeWebSearchFor('openai', 'o1-mini')).toBe(false);
  });

  it('resolves the medium tier when the run has no model yet', () => {
    expect(nativeWebSearchFor('anthropic', undefined)).toBe(true);
    expect(nativeWebSearchFor('google', undefined)).toBe(true);
  });

  it('is undefined for a caller that knows no provider, so the gate offers rather than withholds', () => {
    expect(nativeWebSearchFor(undefined, undefined)).toBeUndefined();
    expect(nativeWebSearchFor('not-a-provider', 'x')).toBeUndefined();
  });
});
