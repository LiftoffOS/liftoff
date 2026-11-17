// Every tool the runtime can put in a catalog must resolve to something that
// can execute it.
//
// The defect this locks down: `buildToolCallRequest` treated "no `__` in the
// name" as "standard tool", so 116 tools the runtime genuinely holds — 97
// sandbox primitives, `code_session`, 10 agent_slack, 7 agent_teams, and
// `delegate_to_agent` — were handed to `executeStandardTool`, which has a case
// for none of them and returns null. Every one produced
// "no handler registered for standard tool: <name>" at dispatch, AFTER passing
// graph validation, because validation only ever asked whether the name was in
// the catalog.
//
// A unit test per family would not have caught it: each family was individually
// plausible. What was missing is the CLOSURE — that the set of names the
// catalog can offer and the set the dispatcher can route are the same set. That
// is what this file asserts, per family, by enumerating the real registries
// rather than a hand-written list that would drift the moment a tool is added.

import {
  resolveToolDispatch,
  entityTypeForDispatch,
  BUILTIN_DISPATCH_NAMES,
  RUNTIME_PSEUDO_CONNECTORS,
  SANDBOX_CONNECTOR,
  AGENT_SLACK_CONNECTOR,
  AGENT_TEAMS_CONNECTOR,
} from '../tool-dispatch-family';
import { buildToolCallRequest } from '../build-tool-call-request';
import { getSandboxFunctionNames } from '../../execution-environments/function-registry';
import { AGENT_SLACK_TOOL_NAMES } from '../../tool-gateway/agent-slack-tool-catalog';
import { AGENT_TEAMS_TOOL_NAMES } from '../../tool-gateway/agent-teams-tool-catalog';
import { STANDARD_TOOLS } from '../../tools/standard-tools';

const standardNames = new Set((STANDARD_TOOLS as Array<{ name: string }>).map((t) => t.name));
const isStandardTool = (n: string) => standardNames.has(n);

describe('every catalog family resolves to a dispatcher', () => {
  // The ratchet. If a new tool family is registered in a catalog without a
  // resolver arm, this fails — which is the only check that can see it, since
  // such a tool passes lint, typecheck, its own tests, and graph validation.
  const families: Array<[string, string[], string]> = [
    ['sandbox', getSandboxFunctionNames(), 'sandbox'],
    ['agent_slack', [...AGENT_SLACK_TOOL_NAMES], 'agent_slack'],
    ['agent_teams', [...AGENT_TEAMS_TOOL_NAMES], 'agent_teams'],
    ['standard', [...standardNames], 'standard'],
    ['builtin', [...BUILTIN_DISPATCH_NAMES], 'builtin'],
  ];

  it.each(families)('%s tools all resolve to kind=%s', (_family, names, expectedKind) => {
    const unresolved = (names as string[])
      .map((n) => ({ n, d: resolveToolDispatch(n, isStandardTool) }))
      .filter(({ d }) => d.kind !== expectedKind);
    expect(unresolved.map(({ n, d }) => `${n} -> ${d.kind}`)).toEqual([]);
  });

  it('code_session resolves to sandbox even though isSandboxTool does not know it', () => {
    // It is registered by mcp-server, not by the sandbox function registry, and
    // dispatches with connector='execution_environment'. A name-based resolver
    // that leaned only on isSandboxTool would silently miss it.
    const d = resolveToolDispatch('code_session', isStandardTool);
    expect(d.kind).toBe('sandbox');
    expect(d).toMatchObject({ connector: SANDBOX_CONNECTOR });
  });
});

describe('the connector values match what the gateway routes on', () => {
  // These strings are a contract with toolGateway.executeInner, which branches
  // on the tool NAME for slack/teams and on connector==='execution_environment'
  // OR isSandboxTool for the sandbox. If these drift, calls fall through to the
  // connector path and are sent to connector-service.
  it.each([
    ['shell_exec', SANDBOX_CONNECTOR, 'sandbox'],
    ['code_session', SANDBOX_CONNECTOR, 'sandbox'],
    ['slack_send_message', AGENT_SLACK_CONNECTOR, AGENT_SLACK_CONNECTOR],
    ['teams_send_message', AGENT_TEAMS_CONNECTOR, AGENT_TEAMS_CONNECTOR],
  ])('%s -> connector=%s entityType=%s', (name, connector, entityType) => {
    const call = buildToolCallRequest(name, {}, { id: 'x', entityType: 'workflow', isStandardTool });
    expect(call.connector).toBe(connector);
    expect(call.entityType).toBe(entityType);
    expect(call.actionType).toBe(name);
  });

  it('every pseudo-connector is excluded from the connector batch fast-path', () => {
    // Not cosmetic: the batcher folds eligible calls into one
    // ConnectorService.ExecuteBatch RPC. A per-agent Slack call in that batch
    // goes to connector-service as a connector operation.
    for (const c of [SANDBOX_CONNECTOR, AGENT_SLACK_CONNECTOR, AGENT_TEAMS_CONNECTOR]) {
      expect(RUNTIME_PSEUDO_CONNECTORS.has(c)).toBe(true);
    }
  });
});

describe('connector tools are unchanged', () => {
  it('splits on the FIRST __ so an alias containing __ still works', () => {
    const call = buildToolCallRequest('google-mail-14a82d9e__get_thread', {}, { id: 'x', isStandardTool });
    expect(call).toMatchObject({
      connector: 'google-mail-14a82d9e',
      actionType: 'get_thread',
      entityType: 'workflow',
    });
  });

  it('external agent tools keep connector=external and the rest of the name', () => {
    const call = buildToolCallRequest('external__alias__toolName', {}, { id: 'x', isStandardTool });
    expect(call).toMatchObject({ connector: 'external', actionType: 'alias__toolName' });
  });

  it('a connector alias wins over a family name it collides with', () => {
    // Aliases are tenant data. If one were ever named `shell_exec`, the bound
    // connector's tool must still win — which is why the `__` split runs first.
    const call = buildToolCallRequest('shell_exec__run', {}, { id: 'x', isStandardTool });
    expect(call).toMatchObject({ connector: 'shell_exec', actionType: 'run' });
  });
});

describe('unresolved is a verdict, not a silent standard tool', () => {
  it('reports unresolved for a name nothing can execute', () => {
    expect(resolveToolDispatch('totally_invented_tool', isStandardTool).kind).toBe('unresolved');
  });

  it('still builds a request, so the failure surfaces at dispatch as before', () => {
    // The throw belongs at validation, which can name the step. Here it would
    // be an opaque mid-run crash.
    const call = buildToolCallRequest('totally_invented_tool', {}, { id: 'x', isStandardTool });
    expect(call.connector).toBe('');
    expect(call.actionType).toBe('totally_invented_tool');
  });

  it('a standard tool keeps an empty connector and the standard entity type', () => {
    // Unchanged from before the resolver: with no explicit entityType, a call
    // with no connector defaults to 'standard' and one with a connector to
    // 'workflow'. Pinned so the resolver cannot quietly alter the shape of the
    // calls that already worked.
    const call = buildToolCallRequest('note_save', {}, { id: 'x', isStandardTool });
    expect(call.connector).toBe('');
    expect(call.entityType).toBe('standard');
    expect(buildToolCallRequest('alias__fn', {}, { id: 'x', isStandardTool }).entityType).toBe('workflow');
  });
});

describe('entityTypeForDispatch', () => {
  it('leaves connector and standard calls on the caller fallback', () => {
    const connectorDispatch = resolveToolDispatch('alias__fn', isStandardTool);
    expect(entityTypeForDispatch(connectorDispatch, 'workflow')).toBe('workflow');
    const standardDispatch = resolveToolDispatch('note_save', isStandardTool);
    expect(entityTypeForDispatch(standardDispatch, 'standard')).toBe('standard');
  });
});
