// A handoff reaches the model as recoverable information, and the model's
// next call is on the NEW handle.
//
// The control plane answers a run_capability whose source produced nothing
// with `kind: 'handoff'`: text naming the next candidate for the same need,
// the arguments it takes, and a fresh handle for it. Three things have to be
// true at this end for that to be worth anything, and a handler unit test
// proves none of them: the tool result the model reads is a FAILURE carrying
// that text (never a success it did not have), the runtime does not retry the
// old handle on its own, and the model's next call — made from the text —
// goes through the same tool loop on the new handle and succeeds.
//
// So this drives a real adapter's tool loop end to end: GeminiAdapter's own
// loop, the real MCP bridge, and the real run_capability handler behind the
// in-process gateway's wire shape. Only the model (scripted: it reads the
// handle out of the tool result it was fed) and the control-plane HTTP call
// are stood in for.

const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: async (...args: unknown[]) => {
        const resp = await mockGenerateContent(...args);
        return (async function* () { yield resp; })();
      },
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED', SAFETY: 'SAFETY', RECITATION: 'RECITATION' },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO', NONE: 'NONE' },
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn(), AbortError: class AbortError extends Error {} }));
jest.mock('@openai/agents', () => ({ run: jest.fn(), Agent: class {}, tool: (d: unknown) => d, webSearchTool: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../clients/platform-backend-client', () => {
  const actual = jest.requireActual('../../../clients/platform-backend-client');
  return { ...actual, capabilitySearchViaBackend: jest.fn(), runCapabilityViaBackend: jest.fn() };
});

// The in-process gateway, as the bridge reaches it: a client whose callTool
// runs the REAL standard-tool handler and answers in the gateway's own wire
// shape — the JSON result on success, the TOOL_ERROR envelope on failure.
const callToolMock = jest.fn();
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({
    acquire: jest.fn(async () => ({ callTool: callToolMock, close: jest.fn() })),
    releaseAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

import { GeminiAdapter } from '../gemini';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationEvent, InvocationInput } from '../types';
import { executeStandardTool } from '../../../tools/standard-tool-handler';
import { runCapabilityViaBackend } from '../../../clients/platform-backend-client';
import { formatToolErrorEnvelope } from '../../../tool-gateway/tool-error-envelope';
import { classifyError } from '@liftoffos/connector-types';

const mockRun = runCapabilityViaBackend as jest.MockedFunction<typeof runCapabilityViaBackend>;

const FIRST = 'cap_r.0123456789ab.AAAAfirst';
const NEXT = 'cap_r.ba9876543210.AAAAnext';
const HANDOFF_TEXT =
  'This capability did not return a result. The next best for the same need takes: keyword (string, required), count (integer); '
  + `call run_capability with capabilityId ${NEXT}, mapping your values onto those argument names. `
  + 'If none of these fits, use the web tools you already have. Do not name or guess the provider behind it.';

function catalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{
      name: 'run_capability',
      description: 'Run one capability',
      inputSchema: { type: 'object', properties: { capabilityId: { type: 'string' }, args: { type: 'object' } } },
      serverId: 'liftoff-tool-gateway',
    }],
  };
}

function input(): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Find the latest posts about shopify' }] }],
    systemPrompt: 's', model: 'gemini-3-pro-preview', provider: 'google', tenantId: 'tenant-1', invocationId: 'inv-handoff', maxTurns: 6,
  };
}

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The gateway's wrapper, over the real handler.
  callToolMock.mockImplementation(async (req: { name: string; arguments: Record<string, unknown> }) => {
    const result = await executeStandardTool(req.name, req.arguments, { tenantId: 'tenant-1', agentId: 'agent-1', invocationId: 'inv-handoff', memoryScope: {}, integrations: [] });
    if (!result || !result.success) {
      const message = typeof result?.error === 'string' ? result.error : 'standard tool failed';
      return { content: [{ type: 'text', text: formatToolErrorEnvelope({ message, code: classifyError({ message }) }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  });
});

describe('a real adapter tool loop follows a capability handoff', () => {
  it('feeds the handoff back as a failed call, and the model\'s next call runs on the new handle', async () => {
    mockRun
      .mockResolvedValueOnce({ ok: false, kind: 'handoff', text: HANDOFF_TEXT })
      .mockResolvedValueOnce({ ok: true, empty: false, text: '[{"url":"https://x","text":"a post"}]' });

    // The model: call the first handle; then read the handle the tool result
    // names and call that one with the arguments it listed; then answer.
    let turn = 0;
    mockGenerateContent.mockImplementation(async (req: { contents: unknown }) => {
      turn += 1;
      if (turn === 1) {
        return {
          text: '', functionCalls: [{ id: 'c1', name: 'run_capability', args: { capabilityId: FIRST, args: { q: 'shopify' } } }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'run_capability', args: { capabilityId: FIRST, args: { q: 'shopify' } } } }] } }],
        };
      }
      if (turn === 2) {
        const transcript = JSON.stringify(req.contents);
        const named = transcript.match(/capabilityId (cap_[A-Za-z0-9_.-]+)/)?.[1];
        expect(named).toBe(NEXT);
        const args = { capabilityId: named, args: { keyword: 'shopify', count: 5 } };
        return {
          text: '', functionCalls: [{ id: 'c2', name: 'run_capability', args }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'run_capability', args } }] } }],
        };
      }
      return { text: 'Here are the posts.', functionCalls: [] };
    });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(catalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    const events = await drain(adapter.invoke(input(), new AbortController().signal));

    // Two calls to the control plane: the first handle once, then the NEW
    // handle with the mapped arguments. The old handle was never retried.
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[0].slice(2, 4)).toEqual([FIRST, { q: 'shopify' }]);
    expect(mockRun.mock.calls[1].slice(2, 4)).toEqual([NEXT, { keyword: 'shopify', count: 5 }]);

    // The first tool result the model read was a FAILURE carrying the handoff
    // text; the second was the data.
    const finished = events.filter((e): e is Extract<InvocationEvent, { type: 'tool_call_finished' }> => e.type === 'tool_call_finished');
    expect(finished).toHaveLength(2);
    const firstText = JSON.stringify(finished[0].result ?? finished[0].error ?? '');
    expect(firstText).toContain('TOOL_ERROR');
    expect(firstText).toContain(NEXT);
    expect(firstText).not.toContain('"success":true');
    expect(JSON.stringify(finished[1].result)).toContain('a post');

    // The loop ended as a success on the model's own answer.
    const completion = events.at(-1) as { type: string; outcome?: string };
    expect(completion.type).toBe('completion');
    expect(completion.outcome).toBe('success');
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  });
});
