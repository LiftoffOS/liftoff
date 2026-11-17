// A family with its own handler must never be batchable.
//
// The defect this pins: "which inputs have a dedicated handler" was written
// three times — as the `if` conditions in `executeInner`, as
// `NON_RPC_CONNECTORS` in `executeBatch`, and as `NON_BATCHABLE_CONNECTORS` in
// `executeToolCalls`. They disagreed. `custom_mcp_server` is routed to its own
// handler and appeared in neither exclusion list, so a batched call carrying it
// was sent to connector-service as an ordinary connector operation and never
// reached the custom-MCP handler at all.
//
// The lists also disagreed in KIND. `executeInner` routes Slack and Teams by
// ACTION TYPE; both exclusion lists matched on CONNECTOR. So an agent-Slack
// tool name arriving under any other connector value was batchable and skipped
// its handler — a disagreement no amount of adding names to lists would fix.

import {
  dedicatedDispatchFamily,
  isOrdinaryConnectorDispatch,
  DEDICATED_DISPATCH_FAMILIES,
} from '../dispatch-families';
import { AGENT_SLACK_TOOL_NAMES } from '../agent-slack-tool-catalog';
import { AGENT_TEAMS_TOOL_NAMES } from '../agent-teams-tool-catalog';

const routing = (o: Partial<{ connector: string; entityType: string; actionType: string }>) => ({
  connector: 'slack', entityType: 'message', actionType: 'send_message', ...o,
});

describe('every dedicated family is excluded from the batch fast path', () => {
  const CASES: Array<[string, ReturnType<typeof routing>]> = [
    ['external MCP tool', routing({ connector: 'external', entityType: 'agent-1' })],
    ['agent-slack',       routing({ actionType: AGENT_SLACK_TOOL_NAMES[0] })],
    ['agent-teams',       routing({ actionType: AGENT_TEAMS_TOOL_NAMES[0] })],
    ['custom MCP server', routing({ connector: 'custom_mcp_server', entityType: 'srv-1' })],
    ['external agent',    routing({ connector: 'external-agent' })],
    ['sandbox',           routing({ connector: 'execution_environment' })],
  ];

  it.each(CASES)('%s has a family', (_name, input) => {
    expect(dedicatedDispatchFamily(input)).not.toBeNull();
  });

  it.each(CASES)('%s is NOT an ordinary connector dispatch', (_name, input) => {
    expect(isOrdinaryConnectorDispatch(input)).toBe(false);
  });

  it('covers every family in the table, so a new one cannot be added untested', () => {
    const covered = new Set(CASES.map(([, i]) => dedicatedDispatchFamily(i)));
    expect(covered).toEqual(new Set(DEDICATED_DISPATCH_FAMILIES.map((f) => f.name)));
  });

  it('routes an agent-Slack tool name by NAME, whatever connector it arrives under', () => {
    // The exact disagreement between the branch conditions and the old
    // connector-keyed exclusion lists.
    expect(isOrdinaryConnectorDispatch(
      routing({ connector: 'github-dd4c4689', actionType: AGENT_SLACK_TOOL_NAMES[0] }),
    )).toBe(false);
  });

  it('still calls an ordinary connector call ordinary', () => {
    expect(dedicatedDispatchFamily(routing({}))).toBeNull();
    expect(isOrdinaryConnectorDispatch(routing({}))).toBe(true);
    expect(isOrdinaryConnectorDispatch(
      routing({ connector: 'github-dd4c4689', actionType: 'pull_request_read' }),
    )).toBe(true);
  });
});
