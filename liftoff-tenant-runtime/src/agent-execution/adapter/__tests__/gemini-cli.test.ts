// GeminiCliAdapter unit tests. `child_process.spawn` is mocked so no CLI runs;
// the fake process prints scripted stream-json lines on stdout and we assert
// what the adapter spawned (argv, environment, the settings and system prompt
// it wrote), what it sent on stdin, the event translation, usage, the HITL
// pause via the shared BridgeContext, and resume.

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface FakeProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { chunks: string[]; end: (_chunk?: string) => void; on: () => void };
  kill: jest.Mock;
  exitCode: number | null;
  killed: boolean;
}
interface SpawnCall { bin: string; args: string[]; opts: { cwd: string; env: Record<string, string | undefined> } }

const spawnCalls: SpawnCall[] = [];
/** The scripted stdout of the NEXT process, as JSONL; `undefined` lines are
 *  skipped. Each entry's `exit` says how the process ends. */
let script: { lines: unknown[]; exit?: number; hang?: boolean; onLine?: (_index: number) => void } = { lines: [] };
let lastProcess: FakeProcess | null = null;

jest.mock('child_process', () => ({
  spawn: (bin: string, args: string[], opts: SpawnCall['opts']) => {
    spawnCalls.push({ bin, args, opts });
    const proc = new EventEmitter() as FakeProcess;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.killed = false;
    proc.stdin = { chunks: [], end: (s?: string) => { if (s) proc.stdin.chunks.push(s); }, on: () => undefined };
    proc.kill = jest.fn(() => {
      proc.killed = true;
      proc.exitCode = 143;
      proc.stdout.end();
      setImmediate(() => proc.emit('close', null, 'SIGTERM'));
      return true;
    });
    lastProcess = proc;
    const current = script;
    setImmediate(async () => {
      for (const [i, line] of current.lines.entries()) {
        if (proc.killed) return;
        proc.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        current.onLine?.(i);
        await new Promise((r) => setImmediate(r));
      }
      if (current.hang || proc.killed) return;
      proc.exitCode = current.exit ?? 0;
      proc.stdout.end();
      setImmediate(() => proc.emit('close', current.exit ?? 0, null));
    });
    return proc;
  },
}));

let capturedBridgeCtx: { pendingHitlGate: unknown; pendingDelegationPause: unknown } | null = null;
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async (_cat: unknown, ctx: never) => {
    capturedBridgeCtx = ctx;
    return { url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) };
  }),
}));
jest.mock('../mcp-client-pool', () => ({ getMcpClientPool: () => ({ releaseAll: jest.fn().mockResolvedValue(undefined) }) }));

import { GeminiCliAdapter, GEMINI_CLI_BUILTINS_EXCLUDED } from '../gemini-cli';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent, PlatformMessage } from '../types';
import { makeRecorder, releaseBuffer } from '../../../trajectories/recorder';

function makeCatalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' }],
  };
}
function makeInput(over: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'sys prompt', model: 'gemini-3-pro', provider: 'google', tenantId: 't1', invocationId: 'inv1', agentId: 'agent-1',
    ...over,
  };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const INIT = { type: 'init', session_id: 'will-be-replaced', model: 'gemini-3-pro' };
const RESULT = { type: 'result', status: 'success', stats: { input_tokens: 12, output_tokens: 8, cached: 3, tool_calls: 0 } };

const home = join(tmpdir(), 'gemini-cli', 't1', 'inv1');

beforeEach(() => {
  spawnCalls.length = 0;
  lastProcess = null;
  capturedBridgeCtx = null;
  script = { lines: [INIT, RESULT] };
  process.env.GCP_PROJECT_ID = 'proj-x';
  delete process.env.GCP_LOCATION;
});

describe('what the adapter spawns', () => {
  it('keeps each invocation\'s settings in a home of its own, so two runs of one agent cannot read each other\'s proxy', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ invocationId: 'inv-A' }), new AbortController().signal));
    await drain(a.invoke(makeInput({ invocationId: 'inv-B' }), new AbortController().signal));
    expect(spawnCalls[0].opts.cwd).not.toBe(spawnCalls[1].opts.cwd);
    expect(spawnCalls[0].opts.env.GEMINI_CLI_HOME).toBe(spawnCalls[0].opts.cwd);
  });

  it('runs the CLI headless on stream-json, with the model, our session id, no auto-approval, and the prompt on stdin', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));

    expect(spawnCalls).toHaveLength(1);
    const { bin, args, opts } = spawnCalls[0];
    expect(bin).toBe('gemini');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '-m', 'gemini-3-pro', '--skip-trust', '--approval-mode', 'default']));
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--yolo');
    const sid = args[args.indexOf('--session-id') + 1];
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).not.toContain('--resume');
    expect(opts.cwd).toBe(home);
    // The prompt went on stdin, not argv: an argument is capped at 128KB.
    expect(lastProcess!.stdin.chunks.join('')).toBe('hi');
  });

  it('gives the child an allow-listed environment with Vertex auth and its own home, never this process\'s secrets', async () => {
    process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      const a = new GeminiCliAdapter();
      a.registerToolCatalog(makeCatalog());
      await drain(a.invoke(makeInput(), new AbortController().signal));
      const env = spawnCalls[0].opts.env;
      expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe('true');
      expect(env.GOOGLE_CLOUD_PROJECT).toBe('proj-x');
      expect(env.GOOGLE_CLOUD_LOCATION).toBe('global');
      expect(env.GEMINI_CLI_HOME).toBe(home);
      expect(env.GEMINI_SYSTEM_MD).toBe(join(home, 'system.md'));
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('points the child at the GATEWAY when the run opened a session, and drops Vertex entirely', async () => {
    // EXCLUSIVE, not additive. This pair puts the CLI on the Gemini Developer API,
    // which the gateway's google door translates onto Vertex.
    //
    // The env alone does not achieve it: `settings.json` selects the auth type and
    // the environment cannot override it, so this pair with `vertex-ai` still
    // selected left the CLI in Vertex mode, reading neither variable, exiting 41
    // before its first request. The settings assertion below is the other half and
    // the two only work together.
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({
      byok: {
        mode: 'managed_gateway', vendor: 'google',
        baseUrl: 'https://gateway.example/byok/google/', token: 'per-run-token',
        rerouteToVendorApi: false,
      },
    }), new AbortController().signal));
    const env = spawnCalls[0].opts.env;
    // The trailing slash is stripped: the control plane builds the base as
    // `<backend>/byok/<vendor>` and a double slash reaches the router as an empty
    // path segment.
    expect(env.GOOGLE_GEMINI_BASE_URL).toBe('https://gateway.example/byok/google');
    expect(env.GEMINI_API_KEY).toBe('per-run-token');
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(env.GOOGLE_CLOUD_LOCATION).toBeUndefined();
    // THE OTHER HALF. `security.auth.selectedType` is what decides which of
    // Google's two APIs the CLI speaks; left at 'vertex-ai' it reads neither
    // variable above and authenticates on the container's own identity instead.
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.security.auth.selectedType).toBe('gemini-api-key');
    // Everything else the child needs is unchanged.
    expect(env.GEMINI_CLI_HOME).toBe(home);
    expect(env.GEMINI_SYSTEM_MD).toBe(join(home, 'system.md'));
  });

  it('keeps Vertex ADC for a credential that is not google', async () => {
    // A run can carry a session for another vendor entirely — a coding session
    // sent elsewhere, a re-routed Grok turn. This engine reads only its own.
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({
      byok: {
        mode: 'managed_gateway', vendor: 'anthropic',
        baseUrl: 'https://gateway.example/byok/anthropic', token: 't',
        rerouteToVendorApi: false,
      },
    }), new AbortController().signal));
    const env = spawnCalls[0].opts.env;
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe('true');
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    // And the settings stay on Vertex, matching the credential this path uses.
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.security.auth.selectedType).toBe('vertex-ai');
  });

  it('writes settings naming the governed proxy as the one trusted MCP server, with only google_web_search left on', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.mcpServers.liftoff).toEqual(expect.objectContaining({
      httpUrl: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'Bearer tok' },
      trust: true,
    }));
    expect(settings.tools.core).toEqual(['google_web_search']);
    // The core allowlist's own enforcement denies every tool it does not
    // name, trusted MCP tools included, and a denied tool is withheld from a
    // headless model. The trusted server's tools are admitted above it.
    expect(settings.tools.allowed).toEqual(['mcp_liftoff_*']);
    expect(settings.tools.exclude).toEqual([...GEMINI_CLI_BUILTINS_EXCLUDED]);
    for (const dangerous of ['run_shell_command', 'read_file', 'write_file', 'web_fetch', 'ask_user']) {
      expect(settings.tools.exclude).toContain(dangerous);
      expect(settings.tools.core).not.toContain(dangerous);
    }
    expect(settings.security.auth.selectedType).toBe('vertex-ai');
  });

  it('forwards the run\'s turn budget as the CLI\'s own session turn cap, and writes none without one', async () => {
    // `model.maxSessionTurns` is the one turn cap the CLI exposes (-1, the
    // default, is unlimited; a headless run exits with an error when it is
    // reached). The tenant's budget reaches this engine through it.
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ maxTurns: 100 }), new AbortController().signal));
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.model).toEqual({ maxSessionTurns: 100 });

    const b = new GeminiCliAdapter();
    b.registerToolCatalog(makeCatalog());
    script = { lines: [INIT, RESULT] };
    await drain(b.invoke(makeInput(), new AbortController().signal));
    const without = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect('model' in without).toBe(false);
  });

  it('puts the platform system prompt in the system slot, not in the user turn', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(readFileSync(join(home, 'system.md'), 'utf8')).toBe('sys prompt');
    expect(lastProcess!.stdin.chunks.join('')).not.toContain('sys prompt');
  });
});

describe('event translation', () => {
  it('maps init, deltas, tool calls and the result to InvocationEvents and completes', async () => {
    script = { lines: [
      INIT,
      { type: 'message', role: 'assistant', content: 'Hel', delta: true },
      { type: 'message', role: 'assistant', content: 'lo', delta: true },
      { type: 'tool_use', tool_name: 'mcp_liftoff_my_tool', tool_id: 'c1', parameters: { x: 1 } },
      { type: 'tool_result', tool_id: 'c1', status: 'success', output: 'ok' },
      'not json — a stray warning line',
      RESULT,
    ] };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out[0].type).toBe('session_started');
    expect(out.filter((e) => e.type === 'assistant_delta').map((e) => (e as { text: string }).text)).toEqual(['Hel', 'lo']);
    const started = out.find((e) => e.type === 'tool_call_started') as { toolName: string; args: unknown; callId: string };
    // The CLI's `mcp_liftoff_` prefix is dropped so the name matches the catalog.
    expect(started).toMatchObject({ toolName: 'my_tool', args: { x: 1 }, callId: 'c1' });
    expect(out.find((e) => e.type === 'tool_call_finished')).toMatchObject({ callId: 'c1', result: 'ok' });
    const usage = out.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, cachedTokens: 3 });
    expect(usage.usage.webSearchRequests).toBeUndefined();
    const last = out[out.length - 1] as { type: string; outcome: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('success');
  });

  it('closes the assistant\'s text as a message at a tool call and at the result', async () => {
    // The CLI streams deltas and never says where a message ends; the boundary
    // is a tool call or the turn's result. Without it the reply streams as
    // tokens and is recorded as nothing.
    script = { lines: [
      INIT,
      { type: 'message', role: 'assistant', content: 'Looking', delta: true },
      { type: 'message', role: 'assistant', content: ' now.', delta: true },
      { type: 'tool_use', tool_name: 'mcp_liftoff_my_tool', tool_id: 'c1', parameters: {} },
      { type: 'tool_result', tool_id: 'c1', status: 'success', output: 'ok' },
      { type: 'message', role: 'assistant', content: 'Done.', delta: true },
      RESULT,
    ] };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const types = out.map((e) => e.type);
    const messages = out.filter((e) => e.type === 'assistant_message') as Array<{ content: Array<{ text: string }> }>;
    expect(messages.map((m) => m.content[0].text)).toEqual(['Looking now.', 'Done.']);
    // The first closes before the call it preceded; the second before the completion.
    expect(types.indexOf('assistant_message')).toBeLessThan(types.indexOf('tool_call_started'));
    expect(types.lastIndexOf('assistant_message')).toBeLessThan(types.indexOf('completion'));
  });

  it('closes nothing when the model said nothing', async () => {
    script = { lines: [INIT, RESULT] };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.some((e) => e.type === 'assistant_message')).toBe(false);
  });

  it('counts google_web_search onto the usage event and surfaces it as web_search', async () => {
    script = { lines: [
      INIT,
      { type: 'tool_use', tool_name: 'google_web_search', tool_id: 'g1', parameters: { query: 'liftoff pricing' } },
      { type: 'tool_result', tool_id: 'g1', status: 'success', output: 'Sources: …' },
      { type: 'tool_use', tool_name: 'google_web_search', tool_id: 'g2', parameters: { query: 'liftoff founders' } },
      { type: 'tool_result', tool_id: 'g2', status: 'success', output: 'Sources: …' },
      RESULT,
    ] };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: { webSearchRequests?: number } };
    expect(usage.usage.webSearchRequests).toBe(2);
    const started = out.filter((e) => e.type === 'tool_call_started') as Array<{ toolName: string }>;
    expect(started.map((s) => s.toolName)).toEqual(['web_search', 'web_search']);
  });

  it('surfaces a failed result as an error completion carrying the provider failure, never empty success', async () => {
    script = { lines: [
      INIT,
      { type: 'result', status: 'error', error: { type: 'ForbiddenError', message: 'permission denied (403)' }, stats: { input_tokens: 1, output_tokens: 0, cached: 0 } },
    ], exit: 1 };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome: string; reason?: string; failure?: { kind: string } };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toContain('permission denied');
    expect(last.failure?.kind).toBeDefined();
    // The tokens spent before the error are still metered.
    expect(out.some((e) => e.type === 'usage')).toBe(true);
  });

  it('calls a process that exits without a result event an error, quoting its stderr', async () => {
    script = { lines: [INIT], exit: 41 };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const events: InvocationEvent[] = [];
    const it = a.invoke(makeInput(), new AbortController().signal)[Symbol.asyncIterator]();
    // First event arrives after spawn; stderr can be written then.
    const first = await it.next();
    events.push(first.value as InvocationEvent);
    lastProcess!.stderr.write('Please set an Auth method');
    for (let r = await it.next(); !r.done; r = await it.next()) events.push(r.value);
    const last = events[events.length - 1] as { type: string; outcome: string; reason: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toContain('code 41');
    expect(last.reason).toContain('Please set an Auth method');
  });

  it('sink enabled: recording gemini_cli_event never turns the turn into an error', async () => {
    script = { lines: [INIT, { type: 'message', role: 'assistant', content: 'x', delta: true }, RESULT] };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const input = makeInput();
    a.registerTrajectoryRecorder(makeRecorder(input.invocationId));
    const out = await drain(a.invoke(input, new AbortController().signal));
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
    releaseBuffer(input.invocationId);
  });
});

describe('pause and resume', () => {
  it('pauses on HITL when the proxy sets pendingHitlGate, stopping the process', async () => {
    script = {
      lines: [
        INIT,
        { type: 'tool_use', tool_name: 'mcp_liftoff_my_tool', tool_id: 'c1', parameters: {} },
        { type: 'tool_result', tool_id: 'c1', status: 'error', error: { type: 'x', message: 'gated' } },
        { type: 'message', role: 'assistant', content: 'should not be reached', delta: true },
        RESULT,
      ],
      hang: true,
      onLine: (i) => { if (i === 1 && capturedBridgeCtx) capturedBridgeCtx.pendingHitlGate = { gateReason: 'approve', pendingToolCalls: [] }; },
    };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; reason: string; token: { adapterKind: string; serialized: string } };
    expect(last.type).toBe('pause_requested');
    expect(last.reason).toBe('hitl_gate');
    expect(last.token.adapterKind).toBe('gemini-cli');
    expect(JSON.parse(last.token.serialized).sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastProcess!.kill).toHaveBeenCalled();
    expect(out.some((e) => e.type === 'assistant_delta')).toBe(false);
  });

  it('resumes the paused session by id with the person\'s text, and nothing else', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const token = { adapterKind: 'gemini-cli', serialized: JSON.stringify({ reason: 'ask_user', input: makeInput(), sessionId: 'sess-42' }) };
    const out = await drain(a.resume(token, { text: 'go ahead' }, new AbortController().signal));
    const { args } = spawnCalls[0];
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-42']));
    expect(args).not.toContain('--session-id');
    expect(lastProcess!.stdin.chunks.join('')).toBe('go ahead');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
  });

  it('honours an aborted signal', async () => {
    script = { lines: [INIT, RESULT], hang: true };
    const ac = new AbortController();
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const it = a.invoke(makeInput(), ac.signal)[Symbol.asyncIterator]();
    await it.next();
    ac.abort();
    const rest: InvocationEvent[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
    const last = rest[rest.length - 1] as { type: string; outcome: string; reason: string };
    expect(last).toMatchObject({ type: 'completion', outcome: 'error', reason: 'aborted' });
    expect(lastProcess!.kill).toHaveBeenCalled();
  });
});

describe('images', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const withImage: PlatformMessage[] = [{
    role: 'user',
    content: [
      { type: 'media', mimeType: 'image/png', dataBase64: PNG, alt: 'a chart' },
      { type: 'text', text: 'what does this show?' },
    ],
  }];

  it('writes the picture under the working directory and attaches it with @path on the first turn', async () => {
    let attachmentPath: string | null = null;
    script = { lines: [INIT, RESULT], onLine: () => {
      const sent = lastProcess!.stdin.chunks.join('');
      const m = /@(attachments\/[^\s]+attachment-1\.png)/.exec(sent);
      if (m && attachmentPath === null) attachmentPath = join(home, m[1]);
    } };
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    const bytesSeen: Buffer[] = [];
    const origOnLine = script.onLine!;
    script.onLine = (i) => { origOnLine(i); if (attachmentPath && existsSync(attachmentPath)) bytesSeen.push(readFileSync(attachmentPath)); };
    await drain(a.invoke(makeInput({ messages: withImage }), new AbortController().signal));
    const sent = lastProcess!.stdin.chunks.join('');
    expect(sent).toContain('what does this show?');
    expect(sent).toContain('attachment 1');
    expect(sent).toContain('a chart');
    expect(sent).toMatch(/Attached images: @attachments\/[^\s]+\/attachment-1\.png/);
    expect(sent).not.toContain('cannot see it');
    // The bytes were the picture's while the turn ran, and are gone after it.
    expect(bytesSeen.length).toBeGreaterThan(0);
    expect(bytesSeen[0].equals(Buffer.from(PNG, 'base64'))).toBe(true);
    expect(existsSync(attachmentPath!)).toBe(false);
  });

  it('still describes a video, which has no attachment path', async () => {
    const a = new GeminiCliAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ messages: [{
      role: 'user', content: [{ type: 'media', mimeType: 'video/mp4', dataBase64: 'AAAA' }, { type: 'text', text: 'and?' }],
    }] }), new AbortController().signal));
    const sent = lastProcess!.stdin.chunks.join('');
    expect(sent).toContain('cannot watch it');
    expect(sent).not.toContain('Attached images');
  });
});
