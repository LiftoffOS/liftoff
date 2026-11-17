import { formatAsText } from '../text-formatter';
import type { AgentStatusResponse } from '../types';

function makeStatus(overrides: Partial<AgentStatusResponse> = {}): AgentStatusResponse {
  return {
    invocationId: 'inv-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    agentName: 'Test Agent',
    status: 'running',
    currentTurn: 2,
    maxTurns: 10,
    phase: 'executing',
    startedAt: new Date(Date.now() - 1500).toISOString(),
    elapsedMs: 1500,
    isTerminal: false,
    currentTool: 'search',
    recentEvents: [
      { type: 'tool_call', toolName: 'search', callId: 'c1', at: new Date(Date.now() - 500).toISOString() },
    ],
    pendingApprovalId: null,
    lastError: null,
    ...overrides,
  };
}

describe('formatAsText', () => {
  it('renders the core fields without ANSI codes by default', () => {
    const out = formatAsText(makeStatus());
    expect(out).toContain('inv      inv-1');
    expect(out).toContain('Test Agent');
    expect(out).toContain('running');
    expect(out).toContain('turn     2/10');
    expect(out).toContain('phase    executing');
    expect(out).toContain('tool     search');
    expect(out).toContain('recent');
    // no ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('emits ANSI color codes when useColor=true and renders pending approval + error lines', () => {
    const out = formatAsText(
      makeStatus({
        status: 'interrupted',
        phase: 'awaiting_approval',
        pendingApprovalId: 'appr-9',
        lastError: 'something broke',
      }),
      true,
    );
    // ANSI present
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain('awaiting appr-9');
    expect(out).toContain('error    something broke');
  });
});
