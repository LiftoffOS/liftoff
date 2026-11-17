import {
  AGENT_TEAMS_TOOL_NAMES,
  AGENT_TEAMS_TOOLS,
  COMMUNICATION_GATED_TOOLS,
  TEAMS_OUTBOUND_TOOL_NAMES,
} from '../agent-teams-tool-catalog';

describe('agent-teams-tool-catalog', () => {
  it('exposes the seven Teams tools', () => {
    expect([...AGENT_TEAMS_TOOL_NAMES]).toEqual([
      'teams_send_message',
      'teams_reply_in_thread',
      'teams_update_message',
      'teams_send_dm',
      'teams_list_channels',
      'teams_get_thread',
      'teams_get_user_info',
    ]);
  });

  it('every tool name has a matching schema with input_schema', () => {
    for (const name of AGENT_TEAMS_TOOL_NAMES) {
      const def = AGENT_TEAMS_TOOLS.find((t) => t.name === name);
      expect(def).toBeDefined();
      expect(def!.input_schema).toBeDefined();
    }
  });

  it('gates the four outbound communication tools', () => {
    const outbound = ['teams_send_message', 'teams_reply_in_thread', 'teams_update_message', 'teams_send_dm'];
    for (const n of outbound) {
      expect(COMMUNICATION_GATED_TOOLS.has(n as never)).toBe(true);
      expect(TEAMS_OUTBOUND_TOOL_NAMES.has(n)).toBe(true);
    }
    // reads are not gated
    expect(COMMUNICATION_GATED_TOOLS.has('teams_list_channels' as never)).toBe(false);
    expect(TEAMS_OUTBOUND_TOOL_NAMES.has('teams_get_thread')).toBe(false);
  });
});
