// Static-analysis regression test: the chat router MUST NOT publish
// tenant.internal_agent.chat_started or tenant.internal_agent.chat_feedback_received
// — the tenant runtime has no handler for either, so the publish was pure
// wasted bandwidth + log noise.
//
// This guard catches a re-introduction by inspecting the router source. A
// runtime test would require booting the full router with Firebase/DB mocks
// which is overkill; the source-grep test gives equivalent coverage for the
// invariant we care about (no string reference to the removed event types).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTER_PATH = resolve(__dirname, '..', 'router.ts');

describe('agent-chat router: removed dead-event publishes', () => {
  const source = readFileSync(ROUTER_PATH, 'utf8');

  it('REGRESSION: does NOT publish tenant.internal_agent.chat_started', () => {
    expect(source).not.toMatch(/['"]tenant\.internal_agent\.chat_started['"]/);
  });

  it('REGRESSION: does NOT publish tenant.internal_agent.chat_feedback_received', () => {
    expect(source).not.toMatch(/['"]tenant\.internal_agent\.chat_feedback_received['"]/);
  });

  it('does not import publishInternalAgentEvent (no other use in this router)', () => {
    expect(source).not.toMatch(/from\s+['"]\.\.\/internal-agents\/events['"]/);
  });
});
