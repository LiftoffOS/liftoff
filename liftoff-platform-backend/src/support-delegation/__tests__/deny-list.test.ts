// A support session can do almost everything a workspace owner or admin can.
// These tests pin that breadth, because the risk with this list is not that it
// is too short, it is that somebody later "hardens" it back into something that
// cannot finish setting a customer's account up.

import { denialReason } from '../deny-list';

describe('denialReason', () => {
  it('allows the full range of owner and admin work', () => {
    expect(denialReason('GET', '/accounts/me')).toBeNull();
    expect(denialReason('PUT', '/accounts/me')).toBeNull();
    expect(denialReason('POST', '/accounts/me/email')).toBeNull();
    expect(denialReason('POST', '/internal-agents')).toBeNull();
    expect(denialReason('POST', '/connections/slack')).toBeNull();
    expect(denialReason('POST', '/agent-chat/threads')).toBeNull();
    expect(denialReason('POST', '/subscriptions')).toBeNull();
    expect(denialReason('POST', '/data-management/exports')).toBeNull();
  });

  it('allows dispatching agent runs and issuing workspace credentials', () => {
    // Both were denied in an earlier draft. Support has to be able to run a
    // team to see what the customer sees it doing, and to hand them working
    // CLI access as part of setting them up.
    expect(denialReason('POST', '/claude-code-proxy/mcp-tokens')).toBeNull();
    expect(denialReason('POST', '/claude-code-proxy/keys')).toBeNull();
  });

  it('blocks platform administration through a customer identity', () => {
    // Not an owner capability, so not an exception to the rule above. Also
    // stops a session being granted from inside a session.
    expect(denialReason('GET', '/admin/platform/state')).not.toBeNull();
    expect(denialReason('POST', '/admin/support-delegation')).not.toBeNull();
  });

  it('is case-insensitive on the method', () => {
    expect(denialReason('post', '/admin/support-delegation')).not.toBeNull();
  });
});
