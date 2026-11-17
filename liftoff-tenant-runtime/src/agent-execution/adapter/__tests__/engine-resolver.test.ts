// Resolver covers every provider × engine-flag combination
// so adapter construction and recorded provenance can never disagree.
//
// The eager adapter modules are mocked so importing../index does not pull the
// ESM-only vendor SDKs (@anthropic-ai/claude-agent-sdk etc.) into the CommonJS
// jest path. resolveExecutionEngine itself imports NO adapter classes.

jest.mock('../anthropic', () => ({ AnthropicAdapter: class AnthropicAdapter {} }));
jest.mock('../openai-wire', () => ({ OpenAiWireAdapter: class OpenAiWireAdapter { constructor(_opts?: unknown) {} } }));
jest.mock('../gemini', () => ({ GeminiAdapter: class GeminiAdapter {} }));

import { engineReadsCatalogTools, resolveExecutionEngine, upstreamSessionIdsFor } from '../engine-resolver';
import { RESOLVABLE_EXECUTION_ENGINE_IDS, RESOLVED_PROVIDERS } from '../types';
import { resolveAdapter, createAdapter } from '../index';
import type { ResolvedProvider, ExecutionEngineId } from '../types';

// THE PAIRING. A vendor family is its models AND its runtime: Anthropic is
// Claude on Claude Code, OpenAI is GPT on Codex, xAI and the open-weights
// families are Grok and the OpenRouter-served models on opencode, Google is
// Gemini on the Gen AI SDK. The wire bridges and ADK are the escape hatches,
// each behind its own service-wide flag. This table is what that pairing IS;
// a change to it is a change to what a workspace gets when it picks a vendor.
describe('resolveExecutionEngine', () => {
  it.each<[ResolvedProvider, NodeJS.ProcessEnv, ExecutionEngineId]>([
    ['anthropic', {}, 'claude-agent-sdk'],
    // Engine flags are irrelevant for the Anthropic path.
    ['anthropic', { OPENAI_ENGINE: 'agents', GOOGLE_ENGINE: 'adk', XAI_ENGINE: 'wire' }, 'claude-agent-sdk'],
    // GPT on Codex; the Agents SDK bridge is the escape hatch.
    ['openai', {}, 'openai-codex'],
    ['openai', { OPENAI_ENGINE: 'agents' }, 'openai-agents'],
    ['openai', { OPENAI_ENGINE: 'codex' }, 'openai-codex'], // any non-'agents' value → default
    // Grok on opencode from xAI's own account; the wire bridge to api.x.ai is
    // the escape hatch, behind a flag of its own — the gateway's flag moves
    // the gateway's families, and Grok is not one of them.
    ['xai', {}, 'opencode'],
    ['xai', { XAI_ENGINE: 'wire' }, 'xai-openai-wire'],
    ['xai', { XAI_ENGINE: 'opencode' }, 'opencode'],
    ['xai', { OPENROUTER_ENGINE: 'wire' }, 'opencode'], // the gateway's flag does not reach Grok
    // One flag for five families: the engine belongs to the GATEWAY, not to a
    // family on it, so it has to move for all of them together.
    ['glm', {}, 'opencode'],
    ['glm', { OPENROUTER_ENGINE: 'wire' }, 'openrouter-openai-wire'],
    ['glm', { OPENROUTER_ENGINE: 'opencode' }, 'opencode'],
    ['qwen', { OPENROUTER_ENGINE: 'wire' }, 'openrouter-openai-wire'],
    ['kimi', {}, 'opencode'],
    ['minimax', { XAI_ENGINE: 'wire' }, 'opencode'], // and Grok's flag does not reach the gateway
    // Gemini on the Gemini CLI; the Gen AI SDK loop and ADK are the two hatches.
    ['google', {}, 'google-gemini-cli'],
    ['google', { GOOGLE_ENGINE: 'genai' }, 'google-genai'],
    ['google', { GOOGLE_ENGINE: 'adk' }, 'google-adk'],
    ['google', { GOOGLE_ENGINE: 'cli' }, 'google-gemini-cli'], // any other value → default
  ])('resolves %s under %o to %s', (provider, env, expected) => {
    expect(resolveExecutionEngine(provider, env)).toBe(expected);
  });

  it('never returns unknown-legacy for any provider/flag combination', () => {
    // Every provider, derived. Written out, this list held five of nine — and
    // the sentinel it exists to rule out is exactly what an unlisted provider
    // resolves to.
    const providers: readonly ResolvedProvider[] = RESOLVED_PROVIDERS;
    const flagSets: NodeJS.ProcessEnv[] = [
      {},
      { OPENAI_ENGINE: 'agents' },
      { OPENROUTER_ENGINE: 'wire' },
      { XAI_ENGINE: 'wire' },
      { GOOGLE_ENGINE: 'adk' },
      { GOOGLE_ENGINE: 'genai' },
      { OPENAI_ENGINE: 'agents', OPENROUTER_ENGINE: 'wire', XAI_ENGINE: 'wire', GOOGLE_ENGINE: 'adk' },
    ];
    for (const p of providers) {
      for (const e of flagSets) {
        expect(resolveExecutionEngine(p, e)).not.toBe('unknown-legacy');
      }
    }
  });

  it('is pure: the injected env wins over process.env', () => {
    const prev = process.env.OPENAI_ENGINE;
    process.env.OPENAI_ENGINE = 'agents';
    try {
      expect(resolveExecutionEngine('openai', {})).toBe('openai-codex');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_ENGINE;
      else process.env.OPENAI_ENGINE = prev;
    }
  });
});

describe('upstreamSessionIdsFor', () => {
  it('routes the Codex identifier to threadId (Codex surfaces a thread id)', () => {
    expect(upstreamSessionIdsFor('openai-codex', 'thr_123')).toEqual({ threadId: 'thr_123' });
  });

  // Every engine EXCEPT codex, derived — so a new engine is routed by this test
  // the day it becomes routable rather than the day somebody remembers it.
  it.each<ExecutionEngineId>(RESOLVABLE_EXECUTION_ENGINE_IDS.filter((e) => e !== 'openai-codex'))(
    'routes %s to sessionId (session-based engines)',
    (engine) => {
      expect(upstreamSessionIdsFor(engine, 'sess_1')).toEqual({ sessionId: 'sess_1' });
    },
  );
});

describe('resolveAdapter / createAdapter agreement', () => {
  // Only exercise the EAGER engines here (claude-agent-sdk, and openai-agents
  // through its escape hatch). The self-managing engines — which include
  // OpenAI's default now — lazy-require ESM-only SDKs covered by their own
  // suites.
  it('resolveAdapter returns the engine id that matches its constructed adapter', () => {
    const saved = {
      o: process.env.OPENAI_ENGINE, r: process.env.OPENROUTER_ENGINE,
      x: process.env.XAI_ENGINE, g: process.env.GOOGLE_ENGINE,
    };
    delete process.env.OPENROUTER_ENGINE;
    delete process.env.XAI_ENGINE;
    delete process.env.GOOGLE_ENGINE;
    process.env.OPENAI_ENGINE = 'agents';
    try {
      const anthropic = resolveAdapter('anthropic');
      expect(anthropic.engineId).toBe('claude-agent-sdk');
      expect(anthropic.adapter).toBeDefined();

      const openai = resolveAdapter('openai');
      expect(openai.engineId).toBe('openai-agents');
      expect(openai.adapter).toBeDefined();

      // createAdapter behavior is unchanged: same construction, no engine id.
      expect(createAdapter('anthropic')).toBeDefined();
      expect(createAdapter('openai')).toBeDefined();
    } finally {
      if (saved.o === undefined) delete process.env.OPENAI_ENGINE; else process.env.OPENAI_ENGINE = saved.o;
      if (saved.r === undefined) delete process.env.OPENROUTER_ENGINE; else process.env.OPENROUTER_ENGINE = saved.r;
      if (saved.x === undefined) delete process.env.XAI_ENGINE; else process.env.XAI_ENGINE = saved.x;
      if (saved.g === undefined) delete process.env.GOOGLE_ENGINE; else process.env.GOOGLE_ENGINE = saved.g;
    }
  });
});

// Which engines the tool-tiering pass can actually reach.
//
// Tiering rewrites `catalog.tools` and nothing else, so this predicate is what
// separates a collapse that reached a model from one that was computed and then
// bypassed. It gets its own test because a wrong-by-omission answer is silent:
// the telemetry reads as a saving the whole time.
describe('engineReadsCatalogTools', () => {
  // Claude alone is handed catalog.servers — the in-process McpServer instance
  // and the vendor servers by URL — and never looks at catalog.tools. Every
  // other engine reads it: openai, openrouter and xai through mcp-bridge, gemini
  // and google-adk by mapping it to function declarations, codex, opencode and
  // the Gemini CLI through exposeCatalogOverHttp.
  //
  // Derived so that a new engine is asserted about rather than assumed. This
  // predicate fails silently when it is wrong by omission, which makes it a
  // poor place to keep a list somebody updates.
  it.each<[ExecutionEngineId, boolean]>(
    RESOLVABLE_EXECUTION_ENGINE_IDS.map((e) => [e, e !== 'claude-agent-sdk'] as [ExecutionEngineId, boolean]),
  )('%s reads catalog.tools: %s', (engine, expected) => {
    expect(engineReadsCatalogTools(engine)).toBe(expected);
  });
});
