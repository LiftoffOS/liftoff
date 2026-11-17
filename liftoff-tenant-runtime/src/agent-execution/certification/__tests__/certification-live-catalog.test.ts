// The catalog reaches the MODEL — the certification check, exercised at level 1.
//
// `tool_catalog_round_trip` reads the adapter's own copy of the catalog back,
// and on the Gemini CLI that copy can be intact while the model never sees a
// tool: the CLI's core allowlist can withhold every MCP declaration from it,
// and certification cannot see that because every behavioural probe runs with
// an EMPTY catalog on purpose. The
// `catalog_reaches_model` check drives one turn with the probe tool LIVE and
// holds the engine to calling it. The live job turns it on; this suite proves
// the check itself — that it passes only when a call to the probe tool is
// observed, registers a catalog whose tool actually answers, asks for the
// tool by name, and is absent (not passed) when it is not switched on.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { certifyEngine, liveProbeCatalog, namesProbeTool } from '../certify';
import type { McpToolCatalog } from '../../adapter/catalog-types';
import type { InvocationEvent, InvocationInput, VendorSdkAdapter } from '../../adapter/types';

/** An adapter that records what it was registered and asked, and answers the
 *  catalog probe with whatever `onInvoke` scripts — a call to the probe tool,
 *  a call to something else, or text alone. */
function scripted(onInvoke: (input: InvocationInput, catalog: McpToolCatalog | null) => InvocationEvent[]): {
  adapter: VendorSdkAdapter;
  seen: { catalogs: McpToolCatalog[]; inputs: InvocationInput[] };
} {
  const seen = { catalogs: [] as McpToolCatalog[], inputs: [] as InvocationInput[] };
  let catalog: McpToolCatalog | null = null;
  const adapter = {
    kind: 'scripted',
    registerToolCatalog: (c: McpToolCatalog) => { catalog = c; seen.catalogs.push(c); },
    registerHitlGate: () => undefined,
    registerAnomalyHandler: () => undefined,
    registerTrajectoryRecorder: () => undefined,
    invoke: async function* (input: InvocationInput) {
      seen.inputs.push(input);
      for (const e of onInvoke(input, catalog)) yield e;
    },
    pause: async () => ({ adapterKind: 'scripted', serialized: JSON.stringify({}) }),
    resume: async function* () {
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'ok' }] } as InvocationEvent;
      yield { type: 'completion', outcome: 'success' } as InvocationEvent;
    },
  } as unknown as VendorSdkAdapter;
  return { adapter, seen };
}

const happy: InvocationEvent[] = [
  { type: 'assistant_message', content: [{ type: 'text', text: 'ok' }] },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'completion', outcome: 'success' },
];

function check(result: Awaited<ReturnType<typeof certifyEngine>>) {
  return result.checkDetail.find((c) => c.name === 'catalog_reaches_model');
}

describe('catalog_reaches_model', () => {
  it('passes when the stream shows the model calling the probe tool, by any of its spellings', async () => {
    for (const spelling of ['probe_tool', 'mcp__liftoff-tool-gateway__probe_tool', 'mcp_liftoff_probe_tool']) {
      const { adapter, seen } = scripted((input) => (
        input.invocationId.startsWith('cert-catalog-')
          ? [{ type: 'tool_call_started', toolName: spelling, args: { record_id: 'cert-1' }, callId: 'c1' }, ...happy]
          : happy
      ));
      const result = await certifyEngine('google-gemini-cli', adapter, { liveCatalog: true, provider: 'google' });
      expect(check(result)?.passed).toBe(true);
      // Asked for by name, on the live catalog.
      const probeTurn = seen.inputs.find((i) => i.invocationId.startsWith('cert-catalog-'))!;
      expect(JSON.stringify(probeTurn.messages)).toContain('probe_tool');
      const live = seen.catalogs.find((c) => c.servers.length > 0)!;
      expect(live.tools.map((t) => t.name)).toEqual(['probe_tool']);
      expect(live.servers[0].kind).toBe('in-process');
    }
  });

  it('fails, naming what the model did instead, when the probe tool is never called', async () => {
    const { adapter } = scripted((input) => (
      input.invocationId.startsWith('cert-catalog-')
        ? [
          { type: 'tool_call_started', toolName: 'google_web_search', args: {}, callId: 'c1' },
          { type: 'assistant_message', content: [{ type: 'text', text: 'I do not have a tool called probe_tool.' }] },
          { type: 'completion', outcome: 'success' },
        ]
        : happy
    ));
    const result = await certifyEngine('google-gemini-cli', adapter, { liveCatalog: true, provider: 'google' });
    const c = check(result)!;
    expect(c.passed).toBe(false);
    expect(c.detail).toContain('google_web_search');
    expect(c.detail).toContain('I do not have a tool');
    expect(result.passed).toBe(false);
  });

  it('is absent, not passed, when the live catalog is not switched on', async () => {
    // The mocked level-1 vendors never call a tool. Recording the check as
    // passed there would be the round-trip defect over again.
    const { adapter, seen } = scripted(() => happy);
    const result = await certifyEngine('google-gemini-cli', adapter, { provider: 'google' });
    expect(check(result)).toBeUndefined();
    expect(seen.catalogs.every((c) => c.servers.length === 0)).toBe(true);
  });

  it('serves the probe tool from a real in-process server, so a call gets an answer', async () => {
    // The tool has to answer or an eager engine throws for want of an
    // executor and the failure reads as the engine's.
    const catalog = liveProbeCatalog();
    const server = catalog.servers[0];
    if (server.kind !== 'in-process') throw new Error('expected an in-process server');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.config.instance.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['probe_tool']);
    const answer = await client.callTool({ name: 'probe_tool', arguments: { record_id: 'cert-1' } });
    expect(JSON.stringify(answer.content)).toContain('probe ok: cert-1');
    await client.close();
  });

  it('recognises the probe tool under every engine\'s spelling and nothing else', () => {
    expect(namesProbeTool('probe_tool')).toBe(true);
    expect(namesProbeTool('mcp__liftoff-tool-gateway__probe_tool')).toBe(true);
    expect(namesProbeTool('mcp_liftoff_probe_tool')).toBe(true);
    expect(namesProbeTool('google_web_search')).toBe(false);
    expect(namesProbeTool('probe_tool_2')).toBe(false);
  });
});
