// The single decision that lets a write/outbound-class capability execute: an
// approved agent run, and nothing else. This is the safety backstop — it runs
// on the class re-derived from the live classification inside executeVendorTool,
// so it holds even if a handle's plaintext marker was stripped or flipped.

import { blockedClassOutcome } from '../vendor-execution';

describe('blockedClassOutcome — who may run a write/outbound capability', () => {
  it('passes (null) when nothing is blocked, whoever the caller is', () => {
    expect(blockedClassOutcome([], 'assistant', false)).toBeNull();
    expect(blockedClassOutcome([], 'agent', false)).toBeNull();
    expect(blockedClassOutcome([], 'caio', false)).toBeNull();
  });

  it('lets an APPROVED agent run execute a blocked capability', () => {
    expect(blockedClassOutcome(['outbound'], 'agent', true)).toBeNull();
    expect(blockedClassOutcome(['customerCommunication', 'write'], 'agent', true)).toBeNull();
  });

  it('refuses a blocked capability for an agent run WITHOUT approval', () => {
    const r = blockedClassOutcome(['outbound'], 'agent', false);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ success: false, requiresApproval: true });
  });

  it('refuses a blocked capability for the assistant and the CAIO even if approved is somehow set', () => {
    // Only the agent caller has a human-in-the-loop admission gate; approval is
    // meaningless for the others and must never let them through.
    expect(blockedClassOutcome(['outbound'], 'assistant', true)).toMatchObject({ requiresApproval: true });
    expect(blockedClassOutcome(['outbound'], 'caio', true)).toMatchObject({ requiresApproval: true });
    expect(blockedClassOutcome(['write'], 'assistant', false)).toMatchObject({ requiresApproval: true });
  });

  it('names the blocked categories in the refusal reason', () => {
    const r = blockedClassOutcome(['outbound', 'customerCommunication'], 'assistant', false);
    expect(r && 'reason' in r ? r.reason : '').toContain('outbound');
    expect(r && 'reason' in r ? r.reason : '').toContain('customerCommunication');
  });
});
