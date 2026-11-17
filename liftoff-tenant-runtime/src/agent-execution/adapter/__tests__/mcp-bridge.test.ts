// mcp-bridge unit — in-process tool-error recovery firing.
//
// dispatchFunctionCall must fire the registered anomaly handler when a tool
// RESULT carries isError:true (not only when callTool throws), and apply the
// recovery LLM's injectMessage via the onRecoveryInject adapter sink. This is
// the parity fix that brings OpenAI/Gemini in-process tool-error recovery up to
// the Anthropic PostToolUse path. The mcp-client-pool is mocked so neither a
// real MCP server nor HTTP is needed.

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');
jest.mock('@modelcontextprotocol/sdk/inMemory.js');

import { dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import { parseToolErrorEnvelope } from '../../../tool-gateway/tool-error-envelope';
import type { McpToolCatalog, InProcessMcpServerConfig, RemoteMcpServerConfig } from '../catalog-types';
import { getMcpClientPool } from '../mcp-client-pool';
import { recordGatewayHitlPause, clearGatewayHitlPause } from '../../../hitl-enforcement/gateway-pause-signal';

function makeInProcessCatalog(): McpToolCatalog {
  const inProcess: InProcessMcpServerConfig = {
    kind: 'in-process',
    id: 'liftoff-tool-gateway',
    config: { name: 'liftoff-tool-gateway', instance: { connect: jest.fn() } as never } as never,
  };
  return {
    servers: [inProcess],
    tools: [
      {
        name: 'slack__send_message',
        description: 'Send Slack message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        serverId: 'liftoff-tool-gateway',
      },
    ],
  };
}

describe('mcp-bridge dispatchFunctionCall — in-process tool-error recovery', () => {
  let acquireMock: jest.Mock;
  let callToolMock: jest.Mock;

  beforeEach(() => {
    callToolMock = jest.fn();
    acquireMock = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = acquireMock;
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('fires recovery once and applies injectMessage when an in-process tool returns isError', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const handlerCalls: Array<{ kind: string; error?: string }> = [];
    const injected: string[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-iserr',
      hitlGate: null,
      anomalyHandler: async (input) => {
        handlerCalls.push({ kind: input.kind, error: input.context.error });
        return { injectMessage: { role: 'user', content: [{ type: 'text', text: 'retry' }] } };
      },
      onRecoveryInject: (text) => { injected.push(text); },
    };

    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    // The error-shaped result is STILL returned to the model.
    expect(result).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
    // Anomaly handler fired exactly once with the extracted error text.
    expect(handlerCalls).toEqual([{ kind: 'tool_call_error', error: 'boom' }]);
    // Corrective text applied through the adapter sink.
    expect(injected).toEqual(['retry']);
  });

  it('drains a gate the handler raised at execute time (the message check under Auto) into a pause on the wire engines', async () => {
    // The in-process McpServer turns the handler's HitlGateError into an
    // error result; the signal it recorded first is what reaches a person.
    const catalog = makeInProcessCatalog();
    clearGatewayHitlPause('inv-gw');
    const context = { messageCheck: { setting: 'auto', asked: { customerCommunication: 0.9 } } };
    callToolMock.mockImplementation(async () => {
      recordGatewayHitlPause('inv-gw', { toolName: 'slack__send_message', reason: 'sensitive_work', args: { text: 'refund' }, matchedCategory: 'customerCommunication', context });
      return { content: [{ type: 'text', text: 'HITL gate: human approval required' }], isError: true };
    });
    let handlerFired = false;
    const abort = jest.fn();
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-gw',
      hitlGate: null,
      abort,
      anomalyHandler: async () => { handlerFired = true; return { escalate: false }; },
      onRecoveryInject: () => undefined,
    };
    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'refund' }, ctx);
    expect(result).toEqual({ error: 'paused_for_human_approval', reason: 'sensitive_work' });
    expect(ctx.pendingHitlGate).toEqual({
      gateReason: 'sensitive_work',
      pendingToolCalls: [{ id: 'pending-gateway-slack__send_message', name: 'slack__send_message', input: { text: 'refund' } }],
      matchedCategory: 'customerCommunication',
      context,
    });
    expect(abort).toHaveBeenCalled();
    // A pause, not a failed tool: recovery is not fired for it.
    expect(handlerFired).toBe(false);
  });

  it('does NOT fire recovery on a successful (isError:false) result', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });
    let handlerFired = false;
    let injectFired = false;
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-ok',
      hitlGate: null,
      anomalyHandler: async () => { handlerFired = true; return { escalate: false }; },
      onRecoveryInject: () => { injectFired = true; },
    };

    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
    expect(handlerFired).toBe(false);
    expect(injectFired).toBe(false);
  });

  it('does NOT fire recovery when the HITL gate denies (no callTool, no recovery)', async () => {
    const catalog = makeInProcessCatalog();
    let handlerFired = false;
    let injectFired = false;
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-deny',
      hitlGate: async () => ({ allow: false, reason: 'denied' }),
      anomalyHandler: async () => { handlerFired = true; return { escalate: false }; },
      onRecoveryInject: () => { injectFired = true; },
    };

    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    expect(result).toEqual({ error: 'HITL gate denied', reason: 'denied' });
    expect(callToolMock).not.toHaveBeenCalled();
    expect(handlerFired).toBe(false);
    expect(injectFired).toBe(false);
  });

  it('fires recovery and applies injectMessage when callTool throws', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockRejectedValue(new Error('upstream timeout'));
    const handlerCalls: Array<{ kind: string; error?: string }> = [];
    const injected: string[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-throw',
      hitlGate: null,
      anomalyHandler: async (input) => {
        handlerCalls.push({ kind: input.kind, error: input.context.error });
        return { injectMessage: { role: 'user', content: [{ type: 'text', text: 'retry-after-throw' }] } };
      },
      onRecoveryInject: (text) => { injected.push(text); },
    };

    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    expect(result).toEqual({ error: 'upstream timeout' });
    expect(handlerCalls).toEqual([{ kind: 'tool_call_error', error: 'upstream timeout' }]);
    expect(injected).toEqual(['retry-after-throw']);
  });

  // `escalate` was declared on AnomalyHandler and read by nothing, so a handler
  // whose only answer is escalate — the workflow-step one — was heard as "carry
  // on" and the model re-issued the rejected call once per turn until its budget
  // ran out. The run then reported the budget, which names neither the tool nor
  // the rejection behind it.
  it('stops the run when the handler escalates, and says which tool it stopped on', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockRejectedValue(new Error('Invalid arguments for tool: triage is required'));
    let aborted = 0;
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-escalate',
      hitlGate: null,
      anomalyHandler: async () => ({ escalate: true }),
      abort: () => { aborted += 1; },
    };

    await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    expect(aborted).toBe(1);
    // The reason the adapter reports instead of a bare "operation was aborted",
    // which is indistinguishable from a caller cancelling.
    expect(ctx.recoveryAbortReason).toContain('slack__send_message');
    expect(ctx.recoveryAbortReason).toContain('triage is required');
  });

  it('leaves the run alone when the handler only injects', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockRejectedValue(new Error('upstream timeout'));
    let aborted = 0;
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-no-escalate',
      hitlGate: null,
      anomalyHandler: async () => ({
        injectMessage: { role: 'user', content: [{ type: 'text', text: 'try another way' }] },
      }),
      onRecoveryInject: () => undefined,
      abort: () => { aborted += 1; },
    };

    await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);

    expect(aborted).toBe(0);
    expect(ctx.recoveryAbortReason).toBeUndefined();
  });
});

// ── Remote vendor-MCP name-mapping + recovery. ───────────────────────────────
// The model-facing catalog `name` is namespaced (collision safety); the vendor
// server dispatches on the BARE `remoteToolName`. The HITL gate reads the
// namespaced `functionName` (what the model called), the wire `tools/call`
// reads the bare name — they MUST NOT read the same field. Recovery fires on a
// vendor-MCP isError result exactly as for in-process tools.
function makeRemoteCatalog(): McpToolCatalog {
  const remote: RemoteMcpServerConfig = {
    kind: 'remote',
    id: 'github-x',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    headers: { Authorization: 'Bearer gh_x' },
  };
  return {
    servers: [remote],
    tools: [
      {
        name: 'github-x__merge_pull_request',   // namespaced, model-facing
        description: 'Merge a PR',
        inputSchema: { type: 'object', properties: { number: { type: 'number' } } },
        serverId: 'github-x',
        remoteToolName: 'merge_pull_request',    // bare, on the wire
      },
    ],
  };
}

describe('mcp-bridge dispatchFunctionCall — remote vendor-MCP name-mapping', () => {
  let acquireMock: jest.Mock;
  let callToolMock: jest.Mock;

  beforeEach(() => {
    callToolMock = jest.fn().mockResolvedValue({ ok: true });
    acquireMock = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = acquireMock;
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('dispatches a remote tool with its BARE remoteToolName on the wire (not the namespaced name)', async () => {
    const catalog = makeRemoteCatalog();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-remote-name', hitlGate: null, anomalyHandler: null,
    };
    await dispatchFunctionCall(catalog, 'github-x__merge_pull_request', { number: 7 }, ctx);
    // Routed to the remote server...
    expect(acquireMock).toHaveBeenCalledWith('inv-remote-name', expect.objectContaining({ kind: 'remote', id: 'github-x' }));
    // ...and the wire name is the BARE vendor name, NOT the namespaced catalog name.
    expect(callToolMock.mock.calls[0][0]).toEqual({ name: 'merge_pull_request', arguments: { number: 7 } });
  });

  it('the HITL gate reads the NAMESPACED name while the wire reads the BARE name (different fields)', async () => {
    const catalog = makeRemoteCatalog();
    const gateNames: string[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-gate-name',
      hitlGate: async ({ toolName }) => { gateNames.push(toolName); return { allow: true }; },
      anomalyHandler: null,
    };
    await dispatchFunctionCall(catalog, 'github-x__merge_pull_request', { number: 7 }, ctx);
    // Gate saw the namespaced name (what name-based gates like merge_to_main
    // match on — see hitl-enforcement prefixed-name tests)...
    expect(gateNames).toEqual(['github-x__merge_pull_request']);
    // ...wire saw the bare name. They are not the same field.
    expect(callToolMock.mock.calls[0][0]).toEqual({ name: 'merge_pull_request', arguments: { number: 7 } });
  });

  it('envelopes a remote vendor-MCP isError result into TOOL_ERROR + fires recovery on the envelope', async () => {
    const catalog = makeRemoteCatalog();
    // Raw vendor error (bypasses the in-process tool-gateway's buildToolErrorContent).
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'failed to merge: 404 not found' }], isError: true });
    const handlerCalls: Array<{ kind: string; error?: string }> = [];
    const injected: string[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-remote-err',
      hitlGate: null,
      anomalyHandler: async (input) => {
        handlerCalls.push({ kind: input.kind, error: input.context.error });
        return { injectMessage: { role: 'user', content: [{ type: 'text', text: 'resolve and retry' }] } };
      },
      onRecoveryInject: (text) => { injected.push(text); },
    };
    const result = await dispatchFunctionCall(catalog, 'github-x__merge_pull_request', { number: 7 }, ctx) as {
      content: { text: string }[]; isError: boolean;
    };
    // The model now reads a uniform, classified TOOL_ERROR envelope instead of raw text.
    expect(result.isError).toBe(true);
    const parsedModel = parseToolErrorEnvelope(result.content[0].text)!;
    expect(parsedModel.code).toBe('not_found'); // "404 not found" → not_found
    expect(parsedModel.retryable).toBe(false);
    // Recovery received the ENVELOPE (so its parseToolErrorEnvelope + fast-trip fire).
    expect(handlerCalls[0].kind).toBe('tool_call_error');
    expect(parseToolErrorEnvelope(handlerCalls[0].error!)!.code).toBe('not_found');
    expect(injected).toEqual(['resolve and retry']);
  });

  it('envelopes a THROWN remote vendor-MCP error into TOOL_ERROR + fires recovery on the envelope', async () => {
    const catalog = makeRemoteCatalog();
    // Vendor server surfaces a 404 as a thrown McpError (not an isError result).
    callToolMock.mockRejectedValue(new Error('MCP error 0: failed to get issue: 404 Not Found'));
    const handlerCalls: Array<{ kind: string; error?: string }> = [];
    const injected: string[] = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-remote-throw',
      hitlGate: null,
      anomalyHandler: async (input) => {
        handlerCalls.push({ kind: input.kind, error: input.context.error });
        return { injectMessage: { role: 'user', content: [{ type: 'text', text: 'resolve and retry' }] } };
      },
      onRecoveryInject: (text) => { injected.push(text); },
    };
    const result = await dispatchFunctionCall(catalog, 'github-x__merge_pull_request', { number: 7 }, ctx) as {
      content: { text: string }[]; isError: boolean;
    };
    // Thrown vendor error is returned to the model as a uniform TOOL_ERROR result.
    expect(result.isError).toBe(true);
    expect(parseToolErrorEnvelope(result.content[0].text)!.code).toBe('not_found');
    // Recovery received the ENVELOPE (fast-trip), not the raw thrown message.
    expect(parseToolErrorEnvelope(handlerCalls[0].error!)!.code).toBe('not_found');
    expect(injected).toEqual(['resolve and retry']);
  });

  it('keeps the legacy { error } shape when an IN-PROCESS tool throws (no remoteToolName)', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockRejectedValue(new Error('upstream boom'));
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-inproc-throw', hitlGate: null, anomalyHandler: null,
    };
    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);
    // In-process throws are already normalized upstream — unchanged shape.
    expect(result).toEqual({ error: 'upstream boom' });
  });

  it('does NOT envelope an IN-PROCESS tool result (no remoteToolName) — buildToolErrorContent already owns it', async () => {
    // In-process catalog tool has no remoteToolName; its isError result passes
    // through untouched (idempotent — already TOOL_ERROR upstream in prod).
    const catalog = makeInProcessCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'boom-raw' }], isError: true });
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-inproc-passthru', hitlGate: null, anomalyHandler: null,
    };
    const result = await dispatchFunctionCall(catalog, 'slack__send_message', { text: 'hi' }, ctx);
    expect(result).toEqual({ content: [{ type: 'text', text: 'boom-raw' }], isError: true });
  });
});

// H3 — async spawn_task_graph returns a {__delegationPending} marker. The bridge
// must stash it AND tear down the OpenAI run() (context.abort), or OpenAI-provider
// agents never pause: the model gets the marker fed back as a normal tool result.
describe('mcp-bridge dispatchFunctionCall — async delegation pause marker', () => {
  let callToolMock: jest.Mock;

  beforeEach(() => {
    callToolMock = jest.fn();
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('stashes pendingDelegationPause AND calls context.abort() on the marker', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ __delegationPending: { parentTaskId: 'p1', childTaskIds: ['c1', 'c2'], deadlineAt: '2026-07-04T00:00:00.000Z' } }) }],
      isError: false,
    });
    let aborted = false;
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-deleg', hitlGate: null, anomalyHandler: null,
      abort: () => { aborted = true; },
    };

    await dispatchFunctionCall(catalog, 'slack__send_message', {}, ctx);

    expect(ctx.pendingDelegationPause).toEqual({ parentTaskId: 'p1', childTaskIds: ['c1', 'c2'], deadlineAt: '2026-07-04T00:00:00.000Z', parentToolCallId: '' });
    expect(aborted).toBe(true);   // without this OpenAI's catch never fires → no pause
  });

  it('does NOT stash or abort on a normal success result', async () => {
    const catalog = makeInProcessCatalog();
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false });
    let aborted = false;
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-plain', hitlGate: null, anomalyHandler: null,
      abort: () => { aborted = true; },
    };

    await dispatchFunctionCall(catalog, 'slack__send_message', {}, ctx);

    expect(ctx.pendingDelegationPause).toBeUndefined();
    expect(aborted).toBe(false);
  });
});

// Deterministic size bound wired at dispatchFunctionCall — the seam OpenAI /
// OpenRouter / Gemini share and Anthropic bypasses. Verifies the gate + bound
// end-to-end through the real dispatch path.
describe('mcp-bridge dispatchFunctionCall — tool-result bound wiring', () => {
  let callToolMock: jest.Mock;

  beforeEach(() => {
    callToolMock = jest.fn();
    const acquireMock = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = acquireMock;
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.TOOL_RESULT_BOUND_ENABLED;
    delete process.env.TOOL_RESULT_MAX_CHARS;
  });

  const ctx = (): BridgeContext => ({
    tenantId: 't1',
    invocationId: 'inv-bound',
    hitlGate: null,
    anomalyHandler: async () => ({ escalate: false }),
    onRecoveryInject: () => {},
  });

  it('bounds an oversized success result when the flag is enabled', async () => {
    process.env.TOOL_RESULT_BOUND_ENABLED = '1';
    process.env.TOOL_RESULT_MAX_CHARS = '2000';
    const huge = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, body: 'z'.repeat(300) })));
    expect(huge.length).toBeGreaterThan(2000);
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: huge }], isError: false });
    const result = await dispatchFunctionCall(makeInProcessCatalog(), 'slack__send_message', {}, ctx()) as { content: Array<{ text: string }> };
    expect(result.content[0].text.length).toBeLessThanOrEqual(2100);
    expect(result.content[0].text).toContain('"id"'); // structure preserved
  });

  it('leaves the result untouched when the bound is switched OFF', async () => {
    // The variable is the OPT-OUT now, not the opt-in: an unset variable leaves
    // the bound on, so the disabled posture has to be asked for explicitly.
    process.env.TOOL_RESULT_BOUND_ENABLED = '0';
    const huge = 'z'.repeat(200_000);
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: huge }], isError: false });
    const result = await dispatchFunctionCall(makeInProcessCatalog(), 'slack__send_message', {}, ctx()) as { content: Array<{ text: string }> };
    expect(result.content[0].text.length).toBe(200_000);
  });

  it('bounds an oversized result with the variable unset — the protection is the default', async () => {
    delete process.env.TOOL_RESULT_BOUND_ENABLED;
    const huge = 'z'.repeat(200_000);
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: huge }], isError: false });
    const result = await dispatchFunctionCall(makeInProcessCatalog(), 'slack__send_message', {}, ctx()) as { content: Array<{ text: string }> };
    expect(result.content[0].text.length).toBeLessThan(200_000);
  });

  it('never bounds an error result even with the flag enabled', async () => {
    process.env.TOOL_RESULT_BOUND_ENABLED = '1';
    process.env.TOOL_RESULT_MAX_CHARS = '2000';
    const hugeErr = 'TOOL_ERROR ' + 'z'.repeat(100_000);
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: hugeErr }], isError: true });
    const result = await dispatchFunctionCall(makeInProcessCatalog(), 'slack__send_message', {}, ctx()) as { content: Array<{ text: string }> };
    expect(result.content[0].text.length).toBe(hugeErr.length);
  });
});

// Approve-with-edits on every engine that dispatches through this bridge:
// OpenAI, Gemini, Codex, OpenCode. The Anthropic engine substitutes at its own
// canUseTool seam and never reaches here.
//
// The failure this guards is silent by construction. The gate says allow, the
// call goes out, and the only difference is that the wording a person approved
// is not the wording that shipped.
describe('mcp-bridge dispatchFunctionCall — the reviewer\'s approved arguments', () => {
  let callToolMock: jest.Mock;

  const gateCtx = (gate: BridgeContext['hitlGate']): BridgeContext => ({
    tenantId: 't1',
    invocationId: 'inv-edit',
    hitlGate: gate,
    anomalyHandler: async () => ({ escalate: false }),
    onRecoveryInject: () => {},
  });

  beforeEach(() => {
    callToolMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });
    const acquireMock = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = acquireMock;
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('dispatches the version the reviewer approved, not the one the model proposed', async () => {
    await dispatchFunctionCall(
      makeInProcessCatalog(),
      'slack__send_message',
      { text: 'agent draft' },
      gateCtx(async () => ({ allow: true, updatedInput: { text: 'their wording' } })),
    );
    expect(callToolMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ arguments: { text: 'their wording' } }),
    );
  });

  it('dispatches the model\'s own arguments on an ordinary approval', async () => {
    await dispatchFunctionCall(
      makeInProcessCatalog(),
      'slack__send_message',
      { text: 'agent draft' },
      gateCtx(async () => ({ allow: true })),
    );
    expect(callToolMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ arguments: { text: 'agent draft' } }),
    );
  });

  it('still judges the model\'s own arguments, not the substituted ones', async () => {
    // Oversight decides on what the agent wanted to do. A gate handed the
    // reviewer\'s version would be judging a decision already made.
    const seen: unknown[] = [];
    await dispatchFunctionCall(
      makeInProcessCatalog(),
      'slack__send_message',
      { text: 'agent draft' },
      gateCtx(async ({ args }) => {
        seen.push(args);
        return { allow: true, updatedInput: { text: 'their wording' } };
      }),
    );
    expect(seen).toEqual([{ text: 'agent draft' }]);
  });
});
