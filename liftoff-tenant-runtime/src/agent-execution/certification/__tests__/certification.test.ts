// Concrete-engine certification across every (engine, provider) pair. Certifies
// the CONCRETE engine driven as a CONCRETE provider: Codex separately from
// OpenAI-Agents, ADK from GenAI, OpenCode from the OpenAI-wire adapter — and
// OpenCode-as-xAI separately from OpenCode-as-OpenRouter. SDK mocks mirror the
// per-adapter suites so no live vendor call runs (level 1).

// Each vendor SDK mock emits a representative HAPPY stream (text + usage +
// terminal) so the behavioral certifyEngine can DRIVE invoke()/resume() and
// assert the consumed events — a stub that returns an empty/never stream would
// (correctly) fail certification now.
jest.mock('@anthropic-ai/claude-agent-sdk', () => {
  const q = () => {
    const gen = (async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 0 } };
    })();
    return Object.assign(gen, { interrupt: jest.fn(async () => undefined) });
  };
  return {
    query: jest.fn(q),
    AbortError: class AbortError extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } },
  };
});
jest.mock('@openai/agents', () => ({
  // run(...) → a StreamedRunResult: async-iterable of stream events + .completed,
  // then .newItems / .rawResponses read after the stream drains. Fresh object per
  // call so invoke() AND resume() (which re-enters invoke()) each get a happy stream.
  run: jest.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'certified' } };
    },
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'certified ok' }] } }],
    rawResponses: [{ usage: { inputTokens: 42, outputTokens: 7, inputTokensDetails: [{ cached_tokens: 0 }] } }],
    history: [],
    interruptions: [],
  })),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
  // The REAL protocol schemas, deliberately not mocked. `run` is stubbed
  // because certification must not call a provider; `protocol` is the vendor's
  // own contract for what an input item may look like, and stubbing it would
  // turn the history-acceptance check into a check of our stub. That is how the
  // production defect survived — a mock accepts whatever it is handed.
  protocol: jest.requireActual('@openai/agents').protocol,
}));
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      // Fresh one-chunk HAPPY stream on EVERY call (invoke + resume each construct a
      // new client): text delta + usageMetadata (numeric promptTokenCount) + STOP with
      // no function calls → exactly one success completion.
      generateContentStream: async () => (async function* () {
        yield {
          text: 'certified',
          candidates: [{ content: { role: 'model', parts: [{ text: 'certified' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
        };
      })(),
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' },
  Type: { STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'ARRAY', TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED' },
}));
jest.mock('@google/adk', () => {
  class LlmAgent { constructor(public cfg: unknown) {} }
  class Runner {
    constructor(public cfg: unknown) {}
    // Fresh happy stream on EVERY call: one text event carrying usageMetadata.
    runAsync() {
      return (async function* () {
        yield { content: { parts: [{ text: 'certification probe response' }] }, usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } };
      })();
    }
  }
  class FunctionTool { constructor(public opts: unknown) {} }
  class InMemorySessionService { getSession = jest.fn(async () => undefined); createSession = jest.fn(async () => ({ id: 's1' })); }
  class TokenBasedContextCompactor { constructor(public o: unknown) {} }
  class LlmSummarizer { constructor(public o: unknown) {} }
  class Gemini { constructor(public o: unknown) {} }
  return {
    LlmAgent, Runner, FunctionTool, InMemorySessionService, TokenBasedContextCompactor, LlmSummarizer, Gemini,
    getFunctionCalls: () => [], getFunctionResponses: () => [], isFinalResponse: () => false,
  };
});
// The opencode server is started by the adapter's own launcher, not the SDK.
jest.mock('../../adapter/opencode/server', () => ({
  // OpenCode: client with a session + a fresh event stream per subscribe() call.
  // text part + step-finish(usage tokens) + session.idle → success completion.
  startOpencode: jest.fn(async () => ({
    client: {
      session: {
        create: jest.fn(async () => ({ data: { id: 's1' } })),
        // The BLOCKING endpoint: it returns when the turn is over, which is
        // what terminates a turn.
        prompt: jest.fn(async () => ({ data: { info: {}, parts: [] } })),
        abort: jest.fn(async () => ({})),
        status: jest.fn(async () => ({ data: { s1: { type: 'idle' } } })),
        messages: jest.fn(async () => ({ data: [] })),
      },
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'certified' } } };
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', tokens: { input: 11, output: 5, cache: { read: 0 } } } } };
            yield { type: 'session.idle', properties: { sessionID: 's1' } };
          })(),
        })),
      },
      postSessionIdPermissionsPermissionId: jest.fn(async () => ({})),
    },
    server: { url: 'http://127.0.0.1:1', close: jest.fn() },
  })),
}));
jest.mock('../../adapter/esm-import', () => ({
  esmImport: async () => ({
    // Codex: startThread().runStreamed() → fresh {events} async-iterable per call.
    // thread.started + item.completed(agent_message text) + turn.completed(usage);
    // no terminal item — the adapter synthesizes the success completion on stream end.
    Codex: class Codex {
      constructor(public o: unknown) {}
      startThread() {
        return {
          id: 't1',
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 't1' };
              yield { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'ok' } };
              yield { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 8, cached_input_tokens: 0 } };
            })(),
          }),
        };
      }
      resumeThread() { return this.startThread(); }
    },
  }),
}));
// The Gemini CLI engine spawns the `gemini` binary. Only `spawn` is replaced —
// everything else on child_process stays real — with a process that prints the
// happy stream-json a headless turn produces: init + one assistant delta + a
// successful result carrying usage.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const { EventEmitter } = jest.requireActual('events');
  const { PassThrough } = jest.requireActual('stream');
  return {
    ...actual,
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = { end: () => undefined, on: () => undefined };
      proc.exitCode = null;
      proc.killed = false;
      proc.kill = () => { proc.killed = true; proc.exitCode = 143; proc.stdout.end(); setImmediate(() => proc.emit('close', null, 'SIGTERM')); return true; };
      setImmediate(() => {
        proc.stdout.write(`${JSON.stringify({ type: 'init', session_id: 'sess-cert', model: 'gemini' })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'certified', delta: true })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 11, output_tokens: 5, cached: 0, tool_calls: 0 } })}\n`);
        proc.exitCode = 0;
        proc.stdout.end();
        setImmediate(() => proc.emit('close', 0, null));
      });
      return proc;
    },
  };
});
// Codex + OpenCode deref httpMcp.url/.bearerToken (no optional chaining) and call
// httpMcp.close() in finally — so this must return a real shape, not undefined.
jest.mock('../../adapter/tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async () => ({ url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) })),
}));
jest.mock('../../adapter/mcp-client-pool', () => ({ getMcpClientPool: () => ({ acquire: jest.fn(), releaseAll: jest.fn().mockResolvedValue(undefined) }) }));
// OpenAiWireAdapter.invoke() unconditionally maps the catalog via mcpToOpenAiFunctionTools;
// return [] (no function tools) so the happy path never dispatches.
jest.mock('../../adapter/mcp-bridge', () => ({ dispatchFunctionCall: jest.fn(), mcpToOpenAiFunctionTools: () => [] }));
// Every credential an engine under certification resolves. A module mock lists
// what it provides, so a reader missing from here is not a stubbed credential
// but an absent function, and the engine fails certification on the mock rather
// than on itself.
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key'),
  getXaiApiKey: jest.fn().mockResolvedValue('test-xai-key'),
}));

import { readFileSync, existsSync, unlinkSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  certifyEngine, writeCertificationArtifact, CERTIFICATION_PAIRS, ENGINE_PROBE_MODEL,
} from '../certify';
import { resolveModelForTier, modelForTierOrUndefined } from '../../../llm/tiers';
import { VENDORS } from '../../adapter/vendors';
import type { EngineProviderPair } from '../../adapter/vendors';
import { CERTIFICATION_CATEGORIES } from '../types';
import { AnthropicAdapter } from '../../adapter/anthropic';
import { OpenAiWireAdapter } from '../../adapter/openai-wire';
import { openAiTarget } from '../../adapter/openai';
import { openRouterTarget } from '../../adapter/openrouter';
import { GeminiAdapter } from '../../adapter/gemini';
import { CodexAdapter } from '../../adapter/codex';
import { GeminiAdkAdapter } from '../../adapter/gemini-adk';
import { OpencodeAdapter } from '../../adapter/opencode';
import { GeminiCliAdapter } from '../../adapter/gemini-cli';
import { createXaiAdapter } from '../../adapter/xai';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../adapter/types';
import type { ExecutionEngineId, VendorSdkAdapter } from '../../adapter';

/** How each engine's adapter is built here. The PAIRS this suite certifies
 *  come from the vendor record; this only says which class each engine is. */
const FACTORY: Record<Exclude<ExecutionEngineId, 'unknown-legacy'>, () => VendorSdkAdapter> = {
  'claude-agent-sdk': () => new AnthropicAdapter(),
  'openai-agents': () => new OpenAiWireAdapter({ target: openAiTarget }),
  'openai-codex': () => new CodexAdapter(),
  'google-genai': () => new GeminiAdapter(),
  'google-adk': () => new GeminiAdkAdapter(),
  'google-gemini-cli': () => new GeminiCliAdapter(),
  'openrouter-openai-wire': () => new OpenAiWireAdapter({ target: openRouterTarget }),
  'xai-openai-wire': () => createXaiAdapter(),
  opencode: () => new OpencodeAdapter(),
};

const PAIRS: Array<EngineProviderPair & { factory: () => VendorSdkAdapter }> =
  CERTIFICATION_PAIRS.map((p) => ({ ...p, factory: FACTORY[p.engine] }));

// The list above used to decide which engines this suite certifies at all, and
// it was written out one short: `xai-openai-wire` had never been certified
// here, at any level, since the day it became routable. It is derived now,
// and per PAIR rather than per engine: opencode serves Grok from xAI's account
// and the open-weights families from OpenRouter's, and a probe per engine
// could only drive one of them.
//
// The probe drives a REAL provider, so it has to name a provider the engine
// actually resolves to. It named `openrouter` for xai: the small tier resolved
// off OpenRouter's map and api.x.ai was asked for `z-ai/glm-4.7-flash`, a 404
// that reads as an engine failure and is a harness one. That is the exact defect
// making Grok its own provider was meant to end — a Grok agent running whatever
// OpenRouter's shared tier map published.
//
// Asserted against the vendor record, NOT against "the model belongs to the
// probe provider": that version passes with the bug in place, because a wrong
// provider resolves a model from its own map perfectly consistently.
it('probes each engine as a provider that actually resolves to it', () => {
  for (const { engine, provider } of CERTIFICATION_PAIRS) {
    const resolvesToThisEngine = Object.values(VENDORS)
      .filter((v) => {
        const e = v.engine as { default: string; alternatives?: Record<string, string> };
        return e.default === engine || Object.values(e.alternatives ?? {}).includes(engine);
      })
      .map((v) => v.provider);
    expect(resolvesToThisEngine).toContain(provider);
  }
});

it('probes opencode from both accounts it serves, and Codex as OpenAI', () => {
  const key = (p: EngineProviderPair) => `${p.engine}+${p.provider}`;
  const keys = CERTIFICATION_PAIRS.map(key);
  expect(keys).toEqual(expect.arrayContaining(['opencode+xai', 'opencode+glm', 'openai-codex+openai']));
});

it('probes each pair with a model that provider publishes', () => {
  for (const { engine, provider } of CERTIFICATION_PAIRS) {
    const model = ENGINE_PROBE_MODEL[engine] ?? resolveModelForTier(provider, 'small');
    expect(model).toBeTruthy();
    if (ENGINE_PROBE_MODEL[engine]) continue;
    const published = ['large', 'medium', 'small']
      .map((t) => modelForTierOrUndefined(provider, t));
    expect(published).toContain(model);
  }
});

// A capped drain must SAY it was capped. Silently truncated, it looks exactly
// like an engine that never terminates — no terminal, no usage, three checks
// failing as contract violations against an engine that was working.
it('names the cap when the drain truncates, instead of returning a headless stream', async () => {
  // A real adapter with only invoke() replaced, so every other method the
  // harness calls is the genuine one. Spreading the instance would drop the
  // prototype and fail on registerToolCatalog rather than on the property.
  const chatty = new OpenAiWireAdapter({ target: openAiTarget });
  (chatty as unknown as { invoke: unknown }).invoke = async function* () {
    for (let i = 0; i < 10; i++) yield { type: 'assistant_delta', text: 'x' };
    yield { type: 'completion', outcome: 'success' };
  };

  const result = await certifyEngine('openai-agents', chatty, { runtimeVersion: 't', imageRevision: 'r', maxEvents: 3 });
  const clean = result.checkDetail.find((c) => c.name === 'clean_stream_completes_success_not_empty');
  expect(clean?.passed).toBe(false);
  expect(clean?.detail).toContain('certification_drain_cap_reached');
});

it('certifies every engine a vendor can resolve to', () => {
  expect([...new Set(PAIRS.map((e) => e.engine))].sort()).toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
});

describe('concrete-engine certification (§7)', () => {
  it.each(PAIRS)('certifies $engine as $provider against every mandatory category', async ({ engine, provider, factory }) => {
    const result = await certifyEngine(engine, factory(), { runtimeVersion: 'test', imageRevision: 'sha-abc', provider });
    expect(result.engine).toBe(engine);
    expect(result.provider).toBe(provider);
    expect(result.contractVersion).toBe('1.0.0');
    // Every mandatory category is represented by at least one check.
    const covered = new Set(result.checkDetail.map((c) => c.category));
    for (const cat of CERTIFICATION_CATEGORIES) expect(covered.has(cat)).toBe(true);
    // The engine passes certification (no failing check).
    expect(result.checkDetail.filter((c) => !c.passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('emits a machine-readable result usable as a CI artifact', async () => {
    const result = await certifyEngine('claude-agent-sdk', new AnthropicAdapter(), { runtimeVersion: '0.3.220', imageRevision: 'sha-1' });
    const json = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(json).toMatchObject({ engine: 'claude-agent-sdk', runtimeVersion: '0.3.220', imageRevision: 'sha-1', contractVersion: '1.0.0', passed: true });
    // Behavioral checks (consume the stream) are represented in the artifact.
    expect(typeof json.checks.emits_exactly_one_terminal_completion).toBe('boolean');
    expect(typeof json.checks.emits_usage_with_tokens).toBe('boolean');
  });

  it('writes an all-pair certification artifact to disk for promotion automation', async () => {
    const results = [];
    for (const { engine, provider, factory } of PAIRS) {
      results.push(await certifyEngine(engine, factory(), { runtimeVersion: '1.0.0-test', imageRevision: 'sha-abc', provider }));
    }
    const outPath = path.join(os.tmpdir(), 'cert-artifact.json');
    const allPassed = writeCertificationArtifact(results, outPath);
    try {
      expect(allPassed).toBe(true);
      expect(existsSync(outPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as {
        allPassed: boolean; engines: Array<{ engine: string; provider: string; passed: boolean }>;
      };
      expect(parsed.allPassed).toBe(true);
      // Counted from the vendor record, not written down. A literal count is the
      // same defect as a literal list: it stays true and stops being complete.
      expect(parsed.engines).toHaveLength(CERTIFICATION_PAIRS.length);
      expect(parsed.engines.map((e) => e.engine)).toContain('openai-codex');
      // Per pair in the artifact too, so promotion automation can tell the
      // two opencode configurations apart.
      expect(parsed.engines.filter((e) => e.engine === 'opencode').map((e) => e.provider).sort()).toEqual(['glm', 'xai']);
    } finally {
      if (existsSync(outPath)) unlinkSync(outPath);
    }
  });

  // ── Negative / fail-closed ──
  it('fails closed for the unknown-legacy sentinel engine', async () => {
    const result = await certifyEngine('unknown-legacy', new AnthropicAdapter());
    expect(result.passed).toBe(false);
    expect(result.checks.engine_id_recognized).toBe(false);
  });

  it('fails closed for an adapter that violates the contract surface', async () => {
    const emptyStream = () => ({ [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; } });
    // Broken adapter: does not retain the catalog and does not implement the recorder tap.
    const broken = {
      invoke: emptyStream,
      injectMessage: async () => undefined,
      pause: async () => ({ adapterKind: 'x', serialized: '{}' }),
      resume: emptyStream,
      registerToolCatalog: () => undefined,
      registerHitlGate: () => undefined,
      registerAnomalyHandler: () => undefined,
    } as unknown as VendorSdkAdapter;
    const result = await certifyEngine('openai-codex', broken);
    expect(result.passed).toBe(false);
    expect(result.checks.tool_catalog_round_trip).toBe(false);
    expect(result.checks.implements_trajectory_recorder).toBe(false);
  });
});
