// A collapsed vendor server's call, followed through the real sequence:
// bridge → gate → result → recorder.
//
// The unit tests for each half passed while the whole failed twice over.
// The bridge unwraps `call_github_dd4c4689_tool` and invokes the gate with the
// INNER name against the catalog the run started with — where that tool lives
// only in `deferredVendorTools` — so a resolver that searched deferred tools
// for wrapper names alone handed the guard a bare name it parsed as nothing.
// And the bridge answers a denied gate with `{ error }` and a failed tool with
// an `isError` envelope, neither of which put an `error` on the event, so a
// recorder that read only the event wrote both down as completed actions.
//
// Nothing here inspects source. The bridge is the real one with the client
// pool mocked; the ledger is a mock that records what it was told.

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');
jest.mock('@modelcontextprotocol/sdk/inMemory.js');

import { dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import { getMcpClientPool } from '../mcp-client-pool';
import type { McpToolCatalog, RemoteMcpServerConfig } from '../catalog-types';
import { sdkCallNameFor } from '../../../hitl-enforcement/tool-name-resolution';
import { parseVendorToolName, recordExternalToolCall } from '../../../action-ledger/record-external-tool-call';
import type { ActionLedgerService } from '../../../action-ledger/service';
import { toolResultFailure } from '../../../tool-gateway/mcp-result';

const SERVER = 'github-dd4c4689';
const REVIEW = `${SERVER}__pull_request_review_write`;
const REVIEW_ARGS = { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123, body: 'LGTM' };

/** The catalog a run starts with once GitHub is collapsed: the search pair in
 *  `tools`, the real tools deferred. */
function collapsedCatalog(): McpToolCatalog {
  const remote: RemoteMcpServerConfig = { kind: 'remote', id: SERVER, url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' };
  return {
    servers: [remote],
    tools: [
      { name: 'search_github_dd4c4689_tools', description: 'find', inputSchema: { type: 'object', properties: {} }, serverId: SERVER },
      { name: 'call_github_dd4c4689_tool', description: 'call', inputSchema: { type: 'object', properties: {} }, serverId: SERVER },
    ],
    deferredVendorTools: new Map([[SERVER, [
      { name: REVIEW, remoteToolName: 'pull_request_review_write', description: 'review', inputSchema: { type: 'object', properties: {} }, serverId: SERVER },
      { name: `${SERVER}__pull_request_read`, remoteToolName: 'pull_request_read', description: 'read', inputSchema: { type: 'object', properties: {} }, serverId: SERVER },
    ]]]),
  };
}

function mockLedger(): { ledger: ActionLedgerService; failures: string[]; outcomes: Array<{ success: boolean }> } {
  const failures: string[] = [];
  const outcomes: Array<{ success: boolean }> = [];
  const ledger = {
    recordIntent: jest.fn().mockResolvedValue('action-1'),
    recordFailure: jest.fn(async (_id: string, err: Error) => { failures.push(err.message); }),
    recordOutcome: jest.fn(async (_id: string, result: { success: boolean }) => { outcomes.push(result); }),
  } as unknown as ActionLedgerService;
  return { ledger, failures, outcomes };
}

describe('a collapsed vendor call, bridge → gate → result → recorder', () => {
  let callToolMock: jest.Mock;
  beforeEach(() => {
    callToolMock = jest.fn();
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('the gate is handed the inner name against the ORIGINAL catalog, and the guard can still parse it', async () => {
    const catalog = collapsedCatalog();
    const seenByGate: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-1',
      hitlGate: async (call) => { seenByGate.push({ toolName: call.toolName, args: call.args }); return { allow: false, reason: 'stop here' }; },
      anomalyHandler: null,
    };
    // The model calls the wrapper, naming the tool by its VENDOR name — the
    // bridge accepts either.
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: 'pull_request_review_write', args: REVIEW_ARGS }, ctx);

    expect(seenByGate).toHaveLength(1);
    expect(seenByGate[0].toolName).toBe(REVIEW);
    expect(seenByGate[0].args).toEqual(REVIEW_ARGS);

    // What `runAdapterHitlGate` does with it, against the same catalog the
    // gate closure captured — the one where the tool is only deferred.
    const external = sdkCallNameFor(catalog, seenByGate[0].toolName, seenByGate[0].args);
    expect(external.toolName).toBe(`mcp__${REVIEW}`);
    expect(parseVendorToolName(external.toolName)).toEqual({ connector: SERVER, actionType: 'pull_request_review_write' });
  });

  it('a denied call is recorded as a FAILURE, not a completed action', async () => {
    const catalog = collapsedCatalog();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-2',
      hitlGate: async () => ({ allow: false, reason: 'denied' }),
      anomalyHandler: null,
    };
    // The bridge's own answer, verbatim — the event carries no error field.
    const result = await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(toolResultFailure(result)).toBe('HITL gate denied');

    const external = sdkCallNameFor(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS });
    const { ledger, failures, outcomes } = mockLedger();
    await recordExternalToolCall({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-2', callId: 'c1',
      toolName: external.toolName, input: external.args, result, ledger,
    });
    expect(outcomes).toEqual([]);
    expect(failures).toEqual(['HITL gate denied']);
  });

  it('a tool that ran and failed is recorded as a failure too', async () => {
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'Validation Failed: body is required' }], isError: true });
    const ctx: BridgeContext = { tenantId: 't1', invocationId: 'inv-3', hitlGate: null, anomalyHandler: null };
    const result = await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx);
    expect(callToolMock).toHaveBeenCalled();

    const external = sdkCallNameFor(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS });
    const { ledger, failures, outcomes } = mockLedger();
    await recordExternalToolCall({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-3', callId: 'c1',
      toolName: external.toolName, input: external.args, result, ledger,
    });
    expect(outcomes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Validation Failed/);
  });

  it('a call that succeeded is recorded as completed — through the SDK text wrapper the wire delivers it in', async () => {
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ id: 9001, state: 'COMMENTED' }) }] });
    const ctx: BridgeContext = { tenantId: 't1', invocationId: 'inv-4', hitlGate: null, anomalyHandler: null };
    const result = await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx);
    // The OpenAI Agents SDK stringifies a function tool's return into
    // `{ type: 'text', text }` before the adapter ever sees it.
    const asTheWireDeliversIt = { type: 'text', text: JSON.stringify(result) };
    expect(toolResultFailure(asTheWireDeliversIt)).toBeUndefined();

    const external = sdkCallNameFor(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS });
    const { ledger, failures, outcomes } = mockLedger();
    await recordExternalToolCall({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-4', callId: 'c1',
      toolName: external.toolName, input: external.args, result: asTheWireDeliversIt, ledger,
    });
    expect(failures).toEqual([]);
    expect(outcomes).toEqual([{ success: true, data: asTheWireDeliversIt }]);
  });
});

describe('what the observer is handed is what the tool RETURNED, not what the model was shown', () => {
  // The bridge frames a vendor result as untrusted content and bounds it
  // before returning it to the SDK. Read through the frame, a vendor's JSON
  // is one long string: the floor never saw the pull number four reads had
  // returned. The observer gets a copy taken before that rewrite; the event
  // stream keeps the model-facing result, because it is persisted and
  // replayed into later model contexts, where the frame is the boundary.
  let callToolMock: jest.Mock;
  beforeEach(() => {
    callToolMock = jest.fn();
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('hands the observer the unframed data while the model gets the framed text', async () => {
    const { toolResultData } = jest.requireActual<typeof import('../../../tool-gateway/mcp-result')>('../../../tool-gateway/mcp-result');
    const framer = jest.requireActual<typeof import('../../../workspace/untrusted-content-wrapper')>('../../../workspace/untrusted-content-wrapper');
    framer._setFramerSecretForTesting(Buffer.alloc(32, 7));
    try {
      const catalog = collapsedCatalog();
      const pr = { number: 123, head: { sha: '3807325c9f1e4b2a8d6c0e7f1a2b3c4d5e6f7a8b' } };
      callToolMock.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(pr) }] });
      const seen: unknown[] = [];
      const ctx: BridgeContext = {
        tenantId: 't1', invocationId: 'inv-5', hitlGate: null, anomalyHandler: null,
        toolResultObserver: async (o) => { seen.push(o.result); return true; },
      };
      const shown = await dispatchFunctionCall(
        catalog, 'call_github_dd4c4689_tool',
        { name: 'github-dd4c4689__pull_request_read', args: { method: 'get', pullNumber: 123 } },
        ctx, { callId: 'call_read_1' },
      );
      expect(callToolMock).toHaveBeenCalledTimes(1);
      expect(toolResultData(seen[0])).toEqual(pr);
      expect(typeof toolResultData(shown)).toBe('string');
      expect(toolResultData(shown) as string).toMatch(/UNTRUSTED/);
    } finally {
      framer._setFramerSecretForTesting(null);
    }
  });
});

describe('the bridge waits for the observer before the model sees the result', () => {
  // The engine does not wait for stream listeners before its next model turn,
  // so a record made off the stream can land after the next call's guard has
  // already asked the store. The bridge's own dispatch is the one point on a
  // wire engine that can wait — and it does, on every exit that is a model's
  // call with an outcome, and not on a pause.
  let callToolMock: jest.Mock;
  beforeEach(() => {
    callToolMock = jest.fn();
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('does not return until the observer has, and hands it the raw result and the call id', async () => {
    const catalog = collapsedCatalog();
    const returned = { content: [{ type: 'text', text: '{"number":123}' }] };
    callToolMock.mockResolvedValue(returned);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: Array<Record<string, unknown>> = [];
    const recordedCalls = new Set<string>();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-6', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async (o) => { seen.push(o as unknown as Record<string, unknown>); await gate; return true; },
      recordedCalls,
    };
    let settled = false;
    const dispatch = dispatchFunctionCall(
      catalog, 'call_github_dd4c4689_tool',
      { name: 'github-dd4c4689__pull_request_read', args: { method: 'get', pullNumber: 123 } },
      ctx, { callId: 'call_r1' },
    ).then(() => { settled = true; });
    // The tool has returned and the observer has been told…
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: `${SERVER}__pull_request_read`, callId: 'call_r1', args: { method: 'get', pullNumber: 123 } });
    expect(seen[0].result).toEqual(returned);
    expect(seen[0].error).toBeUndefined();
    // …and the dispatch is still waiting on it.
    expect(settled).toBe(false);
    release();
    await dispatch;
    expect(settled).toBe(true);
    expect(recordedCalls.has('call_r1')).toBe(true);
  });

  it('tells the observer about a denied call, with its error', async () => {
    const catalog = collapsedCatalog();
    const seen: Array<Record<string, unknown>> = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-7',
      hitlGate: async () => ({ allow: false, reason: 'no' }), anomalyHandler: null,
      toolResultObserver: async (o) => { seen.push(o as unknown as Record<string, unknown>); return true; },
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx, { callId: 'call_d1' });
    expect(callToolMock).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: REVIEW, callId: 'call_d1', error: 'HITL gate denied' });
  });

  it('tells the observer about a tool that ran and failed, with the failure', async () => {
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'Validation Failed' }], isError: true });
    const seen: Array<Record<string, unknown>> = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-8', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async (o) => { seen.push(o as unknown as Record<string, unknown>); return true; },
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx, { callId: 'call_f1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBe('Validation Failed');
  });

  it('says nothing on a pause — nothing has happened yet', async () => {
    const catalog = collapsedCatalog();
    const seen: unknown[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-9',
      hitlGate: async () => ({ allow: false, hitlPause: { gateReason: 'approve first' } as never }),
      anomalyHandler: null, abort: () => undefined,
      toolResultObserver: async (o) => { seen.push(o); return true; },
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx, { callId: 'call_p1' });
    expect(seen).toEqual([]);
  });

  it('a failing observer does not fail the call', async () => {
    const catalog = collapsedCatalog();
    const returned = { content: [{ type: 'text', text: '{}' }] };
    callToolMock.mockResolvedValue(returned);
    const recordedCalls = new Set<string>();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-10', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async () => { throw new Error('store down'); }, recordedCalls,
    };
    await expect(dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: `${SERVER}__pull_request_read`, args: {} }, ctx, { callId: 'call_x' })).resolves.toBeTruthy();
    // And leaves no mark: a record that threw is not one the stream may skip.
    expect(recordedCalls.has('call_x')).toBe(false);
  });
});

describe('the mark means the record EXISTS', () => {
  let callToolMock: jest.Mock;
  beforeEach(() => {
    callToolMock = jest.fn();
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });
  const read = { name: `${SERVER}__pull_request_read`, args: { method: 'get', pullNumber: 123 } };

  it('is not set when the observer says the call was not remembered', async () => {
    // A record that timed out or failed is not one the stream may skip. The
    // observer answers false; the call proceeds; the event goes unmarked and
    // the stream remembers the call, late.
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
    const recordedCalls = new Set<string>();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-11', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async () => false, recordedCalls,
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', read, ctx, { callId: 'call_nm' });
    expect(recordedCalls.has('call_nm')).toBe(false);
  });

  it('is set when it says the call was', async () => {
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
    const recordedCalls = new Set<string>();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-12', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async () => true, recordedCalls,
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', read, ctx, { callId: 'call_m' });
    expect(recordedCalls.has('call_m')).toBe(true);
  });

  it('an input_required interim result reaches the observer as a failure', async () => {
    // The server wants interactive input this path cannot give; the call did
    // not complete. The model is told so with an isError envelope, and the
    // observer must be told the same.
    const catalog = collapsedCatalog();
    callToolMock.mockResolvedValue({ resultType: 'input_required', content: [] });
    const seen: Array<{ error?: string }> = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-13', hitlGate: null, anomalyHandler: null,
      toolResultObserver: async (o) => { seen.push(o); return true; },
    };
    const shown = await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', read, ctx, { callId: 'call_ir' }) as { isError?: boolean };
    expect(shown.isError).toBe(true);
    expect(seen[0].error).toMatch(/input_required/);
  });

  it('a dispatch that throws is observed with the arguments that were DISPATCHED', async () => {
    // The gate may approve an edited version of the call; what the vendor
    // received is the edit. A remote action may succeed and then throw on the
    // way back, so the record must name what was sent, not what was asked.
    const catalog = collapsedCatalog();
    callToolMock.mockRejectedValue(new Error('socket hang up'));
    const seen: Array<{ args: Record<string, unknown>; error?: string }> = [];
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-14',
      hitlGate: async () => ({ allow: true, updatedInput: { ...REVIEW_ARGS, body: 'edited by a person' } }),
      anomalyHandler: null,
      toolResultObserver: async (o) => { seen.push(o); return true; },
    };
    await dispatchFunctionCall(catalog, 'call_github_dd4c4689_tool', { name: REVIEW, args: REVIEW_ARGS }, ctx, { callId: 'call_t' });
    expect(seen).toHaveLength(1);
    expect(seen[0].args.body).toBe('edited by a person');
    expect(seen[0].error).toMatch(/socket hang up/);
  });
});

describe('the ledger writer says when the database refused the row', () => {
  it('a rejecting recordIntent yields "failed", not a resolved nothing', async () => {
    const ledger = {
      recordIntent: jest.fn().mockRejectedValue(new Error('connection refused')),
      recordFailure: jest.fn(), recordOutcome: jest.fn(),
    } as unknown as ActionLedgerService;
    const outcome = await recordExternalToolCall({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-l', callId: 'c1',
      toolName: `mcp__${REVIEW}`, input: REVIEW_ARGS, result: { content: [] }, ledger,
    });
    expect(outcome).toBe('failed');
  });
  it('a written row yields "recorded"; a gateway tool or an unparseable name yields "skipped"', async () => {
    const { ledger } = mockLedger();
    await expect(recordExternalToolCall({ tenantId: 't1', agentId: 'a1', invocationId: 'inv-l2', callId: 'c2', toolName: `mcp__${REVIEW}`, input: REVIEW_ARGS, result: {}, ledger })).resolves.toBe('recorded');
    await expect(recordExternalToolCall({ tenantId: 't1', agentId: 'a1', invocationId: 'inv-l3', callId: 'c3', toolName: 'mcp__liftoff-tool-gateway__google-mail-0105297e__create_draft', input: {}, result: {}, ledger })).resolves.toBe('skipped');
  });
});
