// Stored tool_call step shapes that must dispatch, pinned by name.
//
// A tool_call step can name a tool that passes graph validation — it IS in its
// agent's catalog — and then die at dispatch, so the pre-flight audit reports
// the fleet runnable while steps cannot execute. Connector tools carrying a
// `__` route; the sandbox (shell_exec), agent_slack
// (slack_resolve_channel_by_name, slack_send_message) and builtin
// (delegate_to_agent) families must route too.
//
// These names are deliberately hard-coded rather than derived. They are the
// fixtures, and a regression that quietly broke one family would still pass a
// test that regenerated its own expectations.

import { resolveToolDispatch } from '../tool-dispatch-family';
import { buildToolCallRequest } from '../build-tool-call-request';
import { executeStandardTool } from '../../tools/standard-tool-handler';
import { STANDARD_TOOLS } from '../../tools/standard-tools';

const standardNames = new Set((STANDARD_TOOLS as Array<{ name: string }>).map((t) => t.name));
const isStandardTool = (n: string) => standardNames.has(n);

const WORKFLOW_STEPS: Array<{ agent: string; step: string; tool: string; kind: string }> = [
  { agent: 'Code Reviewer', step: 's4', tool: 'shell_exec', kind: 'sandbox' },
  { agent: 'Code Reviewer', step: 's10', tool: 'slack_resolve_channel_by_name', kind: 'agent_slack' },
  { agent: 'Code Reviewer', step: 's11', tool: 'slack_send_message', kind: 'agent_slack' },
  { agent: 'Release Coordinator', step: 's8', tool: 'slack_send_message', kind: 'agent_slack' },
  { agent: 'Daily Metrics Reporter', step: 's2', tool: 'delegate_to_agent', kind: 'builtin' },
  { agent: 'Customer Support Representative', step: 's1', tool: 'google-mail-14a82d9e__get_thread', kind: 'connector' },
  { agent: 'Customer Support Representative', step: 's2', tool: 'google-mail-14a82d9e__list_messages', kind: 'connector' },
  // find_teammates: the distiller wires the universal peer-collaboration tools
  // into graphs, so the executor needs an arm for them — without one the step
  // resolves 'unresolved' and every message fails graph validation with
  // UNDISPATCHABLE_TOOL. Its two siblings pinned alongside so a regression on
  // either breaks loudly here.
  { agent: 'Competitive Intelligence Analyst', step: 's8', tool: 'find_teammates', kind: 'builtin' },
  { agent: 'Competitive Intelligence Analyst', step: 's8b', tool: 'send_agent_message', kind: 'builtin' },
  { agent: 'Competitive Intelligence Analyst', step: 's8c', tool: 'read_agent_messages', kind: 'builtin' },
];

describe('workflow tool steps', () => {
  it.each(WORKFLOW_STEPS)('$agent $step ($tool) resolves to $kind', ({ tool, kind }) => {
    expect(resolveToolDispatch(tool, isStandardTool).kind).toBe(kind);
  });

  it.each(WORKFLOW_STEPS)('$agent $step ($tool) never lands on the standard-tool path', async ({ tool }) => {
    // The exact failure being fixed. An empty connector routes to
    // executeStandardTool, which returns null for every one of these, producing
    // "no handler registered for standard tool: <name>" and stub_fallback_fired.
    const call = buildToolCallRequest(tool, {}, { id: 'x', entityType: 'workflow', isStandardTool });
    expect(call.connector).not.toBe('');

    // And prove the claim rather than assume it: the standard-tool handler
    // genuinely has no case for these names, so routing them there could only
    // ever fail.
    const handled = await executeStandardTool(call.actionType, {}, {
      tenantId: '00000000-0000-0000-0000-000000000000',
      agentId: '00000000-0000-0000-0000-000000000000',
      memoryScope: { readableLayers: [], writableLayers: [] },
      traceId: 'probe',
    } as never).catch(() => 'threw' as const);
    if (!call.actionType.includes('__')) {
      expect(handled).toBeNull();
    }
  });
});
