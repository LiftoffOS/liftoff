// A hire that reaches for something it was not hired to do asks, whichever
// engine runs it — and once a person says yes, the call runs once.
//
// Three scripted attempts, run through EVERY engine×provider pair the vendor
// record can resolve, each driven through that engine's OWN seam: the Claude
// Agent SDK's `canUseTool`, the OpenAI-wire function tools, Gemini's
// function-call loop, ADK's FunctionTool, and — for the three external
// processes (Codex, opencode, the Gemini CLI) — the governed HTTP catalog
// whose dispatch sets the shared bridge context the adapter reads. The vendor
// SDKs are mocked; the gate, the bridge and each adapter are real.
//
//   destructive   the tool carries the ⚠️ DESTRUCTIVE marker at hitlLevel 2:
//                 the real gate says `destructive_gate`, the adapter surfaces
//                 the conversational ask, and an approval resumes ONE dispatch.
//   over-cap      a single call naming more records than a batch may touch:
//                 the real quantifier says `blast_radius`, with the measurement.
//   absent        a capability the workspace declared it does not have: refused
//                 BY NAME through the shared tri-state helper, not asked —
//                 there is nothing a person could approve into existence.
//
// Each ask is keyed by its category (the gate reason), because that is what
// `/dashboard/review` renders and what a standing policy is keyed on. This is
// proof of existing machinery, per pair: nothing here is new behaviour, and the
// point of enumerating the pairs is that a guarantee resting on one adapter's
// seam is not a guarantee.

import { hitlEnforcementService } from '../../../hitl-enforcement';
import { quantifyPlan, DEFAULT_QUANTIFIER_THRESHOLDS } from '../../../tool-gateway/plan-quantifier';
import { refusalForTool } from '../../../tool-gateway/capability-tri-state';
import { BLAST_RADIUS_GATE_REASON } from '../../blast-radius-gate';
import { dispatchFunctionCall } from '../mcp-bridge';
import { engineProviderPairs, type EngineProviderPair } from '../vendors';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent, HitlGate, VendorSdkAdapter, ExecutionEngineId } from '../types';

// ── The scripted attempt, shared by every SDK mock ────────────────────────

interface Scripted { name: string; args: Record<string, unknown> }
const script: { call: Scripted } = { call: { name: '', args: {} } };
/** What actually ran: the pool's callTool on the bridge engines, and the SDK
 *  executing the allowed tool on Claude. */
const dispatched: Array<{ name: string; args: unknown }> = [];
/** The last permission decision Claude's SDK was handed, for the refusal row. */
let lastCanUseToolDecision: { behavior: string; message?: string } | null = null;
/** What each seam handed back to the model for the scripted call — the
 *  function result on the bridge engines. A refusal is read from here. */
const modelSaw: unknown[] = [];
/** The bridge context the external-process engines expose their catalog with. */
let capturedBridge: { ctx: import('../mcp-bridge').BridgeContext; catalog: McpToolCatalog } | null = null;

jest.mock('../../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key'),
  getXaiApiKey: jest.fn().mockResolvedValue('test-xai-key'),
}));
// The gate's policy lookups reach the governance engine; here there is none.
jest.mock('../../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

// The MCP client every bridge dispatch acquires: records the call, answers ok.
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({
    acquire: jest.fn(async () => ({
      callTool: jest.fn(async (req: { name: string; arguments: unknown }) => {
        dispatched.push({ name: req.name, args: req.arguments });
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    })),
    releaseAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

// ── Claude Agent SDK: the model asks permission, the SDK runs what is allowed ─
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(({ options }: { options: { canUseTool: (n: string, a: unknown, c: { signal: AbortSignal }) => Promise<{ behavior: string; message?: string; updatedInput?: unknown }> } }) => {
    const gen = (async function* () {
      const d = await options.canUseTool(script.call.name, script.call.args, { signal: new AbortController().signal });
      lastCanUseToolDecision = d;
      if (d.behavior === 'allow') {
        dispatched.push({ name: script.call.name, args: d.updatedInput ?? script.call.args });
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
        return;
      }
      // Denied: the SDK reports the turn ended in error; the adapter's stash
      // decides whether that is a pause or a denial.
      yield { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
    })();
    return Object.assign(gen, { interrupt: jest.fn(async () => undefined) });
  }),
  AbortError: class AbortError extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } },
}));

// ── OpenAI Agents SDK (the wire engines): run() calls the function tool ─────
jest.mock('@openai/agents', () => ({
  run: jest.fn((agent: { opts: { tools: Array<{ name: string; execute: (a: unknown, c: unknown, d: unknown) => Promise<unknown> }> } }) => ({
    async *[Symbol.asyncIterator]() {
      const tool = agent.opts.tools.find((t) => t.name === script.call.name);
      if (tool) modelSaw.push(await tool.execute(script.call.args, {}, { toolCall: { callId: 'c1' } }));
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
    },
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'done' }] } }],
    rawResponses: [{ usage: { inputTokens: 1, outputTokens: 1, inputTokensDetails: [{ cached_tokens: 0 }] } }],
    history: [],
    interruptions: [],
  })),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
  protocol: jest.requireActual('@openai/agents').protocol,
}));

// ── Gemini (Gen AI SDK): round 0 calls the function, round 1 answers ─────────
let geminiRound = 0;
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: async (params: { contents?: Array<{ parts?: Array<{ functionResponse?: { response?: unknown } }> }> }) => (async function* () {
        for (const c of params.contents ?? []) {
          for (const part of c.parts ?? []) if (part.functionResponse) modelSaw.push(part.functionResponse.response);
        }
        if (geminiRound++ === 0) {
          const fc = { id: 'c1', name: script.call.name, args: script.call.args };
          yield {
            candidates: [{ content: { role: 'model', parts: [{ functionCall: fc }] }, finishReason: 'STOP' }],
            functionCalls: [fc],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          };
          return;
        }
        yield {
          text: 'done',
          candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      })(),
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' },
  Type: { STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'ARRAY', TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED' },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO' },
}));

// ── ADK: the Runner executes the FunctionTool itself ────────────────────────
jest.mock('@google/adk', () => {
  class FunctionTool { constructor(public opts: { name: string; execute: (a: unknown, c: unknown) => Promise<unknown> }) {} }
  class LlmAgent { constructor(public cfg: { tools?: FunctionTool[] }) {} }
  class Runner {
    constructor(public cfg: { agent: LlmAgent }) {}
    runAsync() {
      const agent = this.cfg.agent;
      return (async function* () {
        const tool = (agent.cfg.tools ?? []).find((t) => t.opts.name === script.call.name);
        if (tool) {
          yield { content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: script.call.name, args: script.call.args } }] } };
          modelSaw.push(await tool.opts.execute(script.call.args, { functionCallId: 'c1' }));
        }
        yield { content: { parts: [{ text: 'done' }] }, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      })();
    }
  }
  class InMemorySessionService { getSession = jest.fn(async () => undefined); createSession = jest.fn(async () => ({ id: 's1' })); }
  class TokenBasedContextCompactor { constructor(public o: unknown) {} }
  class LlmSummarizer { constructor(public o: unknown) {} }
  class Gemini { constructor(public o: unknown) {} }
  return {
    LlmAgent, Runner, FunctionTool, InMemorySessionService, TokenBasedContextCompactor, LlmSummarizer, Gemini,
    getFunctionCalls: (e: { content?: { parts?: Array<{ functionCall?: unknown }> } }) =>
      (e.content?.parts ?? []).map((p) => p.functionCall).filter(Boolean),
    getFunctionResponses: () => [], isFinalResponse: () => false,
  };
});

// ── The external processes: the governed HTTP catalog is the seam ───────────
//
// The proxy's dispatch is `dispatchFunctionCall` on the captured bridge
// context — the real production route, minus the HTTP hop.
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async (catalog: McpToolCatalog, ctx: never) => {
    capturedBridge = { ctx, catalog };
    return { url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) };
  }),
}));
async function modelCallsThroughProxy(): Promise<void> {
  if (!capturedBridge) throw new Error('catalog not exposed before the model called it');
  modelSaw.push(await dispatchFunctionCall(capturedBridge.catalog, script.call.name, script.call.args, capturedBridge.ctx, { callId: 'c1' }));
}
jest.mock('../opencode/server', () => ({
  startOpencode: jest.fn(async () => ({
    client: {
      session: {
        create: jest.fn(async () => ({ data: { id: 's1' } })),
        prompt: jest.fn(async () => {
          await modelCallsThroughProxy();
          return { data: { info: {}, parts: [] } };
        }),
        abort: jest.fn(async () => ({})),
        status: jest.fn(async () => ({ data: { s1: { type: 'idle' } } })),
        messages: jest.fn(async () => ({ data: [] })),
      },
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'done' } } };
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', tokens: { input: 1, output: 1, cache: { read: 0 } } } } };
            yield { type: 'session.idle', properties: { sessionID: 's1' } };
          })(),
        })),
      },
      tool: { ids: jest.fn(async () => ({ data: [] })) },
      postSessionIdPermissionsPermissionId: jest.fn(async () => ({})),
    },
    server: { url: 'http://127.0.0.1:1', close: jest.fn() },
  })),
}));
jest.mock('../esm-import', () => ({
  esmImport: async () => ({
    Codex: class Codex {
      constructor(public o: unknown) {}
      startThread() {
        return {
          id: 't1',
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 't1' };
              await modelCallsThroughProxy();
              yield { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'done' } };
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
            })(),
          }),
        };
      }
      resumeThread() { return this.startThread(); }
    },
  }),
}));
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
      setImmediate(async () => {
        proc.stdout.write(`${JSON.stringify({ type: 'init', session_id: 'sess-1', model: 'gemini' })}\n`);
        await modelCallsThroughProxy();
        if (proc.killed) return;
        proc.stdout.write(`${JSON.stringify({ type: 'tool_use', tool_name: `mcp_liftoff_${script.call.name}`, tool_id: 'c1', parameters: script.call.args })}\n`);
        await new Promise((r) => setImmediate(r));
        if (proc.killed) return;
        proc.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'done', delta: true })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1, cached: 0, tool_calls: 1 } })}\n`);
        proc.exitCode = 0;
        proc.stdout.end();
        setImmediate(() => proc.emit('close', 0, null));
      });
      return proc;
    },
  };
});

import { constructAdapterForEngine } from '../index';

// ── The catalog and the gate ───────────────────────────────────────────────

const TENANT = 't1';
const AGENT = 'a1';

/** Three tools, one per attempt. The destructive one carries the marker the
 *  level-2 gate reads; the bulk one is an ordinary archive whose ARGUMENTS
 *  are what the quantifier measures; the phone one serves a capability the
 *  workspace has declared absent. */
function catalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { type: 'sdk' } as never }],
    tools: [
      { name: 'crm__delete_contact', description: '⚠️ DESTRUCTIVE Delete a contact', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, serverId: 'liftoff-tool-gateway', effect: 'write' as never },
      { name: 'crm__archive_records', description: 'Archive records', inputSchema: { type: 'object', properties: { ids: { type: 'array' } } }, serverId: 'liftoff-tool-gateway', effect: 'write' as never },
      { name: 'phone__place_call', description: 'Place a phone call', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, serverId: 'liftoff-tool-gateway', effect: 'write' as never },
    ],
  };
}

type Category = 'destructive_gate' | typeof BLAST_RADIUS_GATE_REASON | 'absent';

interface Scenario {
  name: string;
  category: Category;
  call: Scripted;
  /** What the gate MUST produce: an ask keyed by the category, or a refusal. */
  outcome: 'ask' | 'refusal';
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a destructive attempt',
    category: 'destructive_gate',
    call: { name: 'crm__delete_contact', args: { id: 'contact-7' } },
    outcome: 'ask',
  },
  {
    name: 'an over-cap attempt',
    category: BLAST_RADIUS_GATE_REASON,
    call: { name: 'crm__archive_records', args: { ids: Array.from({ length: DEFAULT_QUANTIFIER_THRESHOLDS.maxEntitiesPerBatch + 5 }, (_, i) => `r-${i}`) } },
    outcome: 'ask',
  },
  {
    name: 'an absent-capability attempt',
    category: 'absent',
    call: { name: 'phone__place_call', args: { to: '+15550100' } },
    outcome: 'refusal',
  },
];

/** The production gate's decision, as the adapter seam receives it.
 *
 *  The pieces are the real ones — `checkHitlGate` for the kind of an action,
 *  `quantifyPlan` for its size, `refusalForTool` for a capability the workspace
 *  does not have — composed the way `runAdapterHitlGate` composes them, with
 *  the one addition a resume makes: an approval for exactly this (name|args),
 *  consumed once, the way `hitlResumeDecision` arms it. */
function gateFor(opts: { approvedOnce?: Scripted }): HitlGate {
  let consumed = false;
  const tools = catalog().tools.map((t) => ({
    name: t.name, description: t.description, effect: (t as { effect?: string }).effect, categories: [] as string[],
    inputSchema: t.inputSchema,
  }));
  return async ({ toolName, args }) => {
    const input = (args ?? {}) as Record<string, unknown>;
    if (opts.approvedOnce && !consumed && toolName === opts.approvedOnce.name && JSON.stringify(input) === JSON.stringify(opts.approvedOnce.args)) {
      consumed = true;
      return { allow: true };
    }
    // What the workspace cannot do at all: refused, not asked.
    const refusal = refusalForTool({
      toolName,
      capabilityForTool: (n) => (n.startsWith('phone__') ? 'telephony' : null),
      capabilityStates: { telephony: 'absent' },
    });
    if (refusal) return { allow: false, reason: refusal.message };
    // The kind of the action.
    const kind = await hitlEnforcementService.checkHitlGate(
      [{ id: 'c1', name: toolName, input }], { escalation: 'sensitive', sensitiveWork: {}, communication: 'auto' } as never,
      2, tools as never, TENANT, AGENT, { dryRun: true },
    );
    if (kind.shouldGate) {
      return { allow: false, hitlPause: { gateReason: kind.reason!, pendingToolCalls: [{ id: 'c1', name: toolName, input }], ...(kind.matchedCategory ? { matchedCategory: kind.matchedCategory } : {}) } };
    }
    // Its size.
    const size = quantifyPlan([{ name: toolName, input }], { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 });
    if (size.decision === 'confirm_required') {
      return { allow: false, hitlPause: { gateReason: BLAST_RADIUS_GATE_REASON, pendingToolCalls: [{ id: 'c1', name: toolName, input }], measuredReasons: size.reasons } };
    }
    return { allow: true };
  };
}

const MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-8', openai: 'gpt-5-codex', google: 'gemini-3-pro-preview', xai: 'grok-4.6', glm: 'z-ai/glm-5.2',
};

function input(pair: EngineProviderPair): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }],
    systemPrompt: 'system', model: MODEL[pair.provider] ?? 'm', provider: pair.provider as InvocationInput['provider'],
    tenantId: TENANT, invocationId: `inv-${pair.engine}-${pair.provider}`, maxTurns: 3,
  };
}

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function build(engine: ExecutionEngineId, gate: HitlGate): VendorSdkAdapter {
  const adapter = constructAdapterForEngine(engine);
  adapter.registerToolCatalog(catalog());
  adapter.registerHitlGate(gate);
  adapter.registerAnomalyHandler(async () => ({ decision: 'continue' } as never));
  return adapter;
}

const PAIRS = engineProviderPairs();

beforeEach(() => {
  dispatched.length = 0;
  modelSaw.length = 0;
  lastCanUseToolDecision = null;
  capturedBridge = null;
  geminiRound = 0;
  process.env.AUTONOMOUS_SESSION_CACHE_DISABLED = '1';
});

it('enumerates the pairs the vendor record can resolve', () => {
  expect(PAIRS.length).toBeGreaterThanOrEqual(9);
  expect(PAIRS.map((p) => `${p.engine}+${p.provider}`)).toEqual(expect.arrayContaining([
    'claude-agent-sdk+anthropic', 'openai-codex+openai', 'openai-agents+openai',
    'google-gemini-cli+google', 'google-genai+google', 'google-adk+google',
    'opencode+xai', 'xai-openai-wire+xai', 'opencode+glm', 'openrouter-openai-wire+glm',
  ]));
});

describe.each(PAIRS.map((p) => [`${p.engine} as ${p.provider}`, p] as const))('%s', (_label, pair) => {
  describe.each(SCENARIOS.filter((s) => s.outcome === 'ask').map((s) => [s.name, s] as const))('%s', (_n, scenario) => {
    it(`produces the conversational ask, keyed ${scenario.category}, and dispatches nothing`, async () => {
      script.call = scenario.call;
      const adapter = build(pair.engine, gateFor({}));
      const events = await drain(adapter.invoke(input(pair), new AbortController().signal));

      const pause = events.find((e) => e.type === 'pause_requested') as Extract<InvocationEvent, { type: 'pause_requested' }> | undefined;
      expect(pause).toBeDefined();
      expect(pause!.reason).toBe('hitl_gate');
      // The ask names its category and the call it is about — what the review
      // card renders and what a standing policy is keyed on.
      expect(pause!.gateContext?.gateReason).toBe(scenario.category);
      expect(pause!.gateContext?.pendingToolCalls.map((c) => c.name)).toEqual([scenario.call.name]);
      if (scenario.category === BLAST_RADIUS_GATE_REASON) {
        // Size carries its measurement; one static label cannot say how many.
        expect(pause!.gateContext?.measuredReasons?.join(' ')).toMatch(/\d+/);
      }
      // Asked means not done.
      expect(dispatched).toEqual([]);
      // And the turn ended on the ask, not on a success that outran it.
      expect(events.filter((e) => e.type === 'completion' && (e as { outcome: string }).outcome === 'success')).toEqual([]);
    });

    it('resumes on approval: the approved call runs exactly once', async () => {
      script.call = scenario.call;
      const adapter = build(pair.engine, gateFor({ approvedOnce: scenario.call }));
      const events = await drain(adapter.invoke(input(pair), new AbortController().signal));

      expect(events.find((e) => e.type === 'pause_requested')).toBeUndefined();
      expect(dispatched.map((d) => d.name)).toEqual([scenario.call.name]);
      expect(dispatched[0].args).toEqual(scenario.call.args);
      const last = events[events.length - 1] as { type: string; outcome?: string };
      expect(last.type).toBe('completion');
      expect(last.outcome).toBe('success');
    });
  });

  describe('an absent-capability attempt', () => {
    const scenario = SCENARIOS.find((s) => s.outcome === 'refusal')!;
    it('is refused by name — not asked, not dispatched', async () => {
      script.call = scenario.call;
      const adapter = build(pair.engine, gateFor({}));
      const events = await drain(adapter.invoke(input(pair), new AbortController().signal));

      // Nothing to approve into existence, so no ask.
      expect(events.find((e) => e.type === 'pause_requested')).toBeUndefined();
      expect(dispatched).toEqual([]);
      // The refusal names the capability and says it is not an outage, so the
      // model can tell the person which thing the workspace does not have.
      const refusalText = pair.engine === 'claude-agent-sdk'
        ? lastCanUseToolDecision?.message ?? ''
        : JSON.stringify(modelSaw);
      expect(refusalText).toMatch(/telephony/);
      expect(refusalText).toMatch(/not an outage/i);
    });
  });
});
