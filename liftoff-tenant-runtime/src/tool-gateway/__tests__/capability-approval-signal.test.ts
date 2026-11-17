// The approval side-channel that carries a human's write-capability approval
// from the admission gate to the run_capability handler, in-process.

import {
  capabilityApprovalKey,
  recordCapabilityApproval,
  consumeCapabilityApproval,
  capabilityHandleNeedsApproval,
} from '../capability-approval-signal';

describe('capabilityApprovalKey', () => {
  it('is null without an invocation or a capabilityId (cannot arm)', () => {
    expect(capabilityApprovalKey(undefined, { capabilityId: 'cap_w.x', args: {} })).toBeNull();
    expect(capabilityApprovalKey('inv', { args: {} })).toBeNull();
    expect(capabilityApprovalKey('inv', undefined)).toBeNull();
  });

  it('is stable for the same input and differs when the input differs', () => {
    const a = capabilityApprovalKey('inv', { capabilityId: 'cap_w.x', args: { to: '+1' } });
    const b = capabilityApprovalKey('inv', { capabilityId: 'cap_w.x', args: { to: '+1' } });
    const c = capabilityApprovalKey('inv', { capabilityId: 'cap_w.x', args: { to: '+2' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('record / consume', () => {
  it('consumes a recorded approval exactly once', () => {
    const key = capabilityApprovalKey('inv-a', { capabilityId: 'cap_w.x', args: {} });
    recordCapabilityApproval(key);
    expect(consumeCapabilityApproval(key)).toBe(true);
    expect(consumeCapabilityApproval(key)).toBe(false); // gone after one read
  });

  it('returns false for a key that was never recorded', () => {
    const key = capabilityApprovalKey('inv-b', { capabilityId: 'cap_w.y', args: {} });
    expect(consumeCapabilityApproval(key)).toBe(false);
  });

  it('does not throw or arm on a null key', () => {
    expect(() => recordCapabilityApproval(null)).not.toThrow();
    expect(consumeCapabilityApproval(null)).toBe(false);
  });
});

describe('capabilityHandleNeedsApproval', () => {
  it('is true only for a write-marked handle', () => {
    expect(capabilityHandleNeedsApproval('cap_w.abc')).toBe(true);
    expect(capabilityHandleNeedsApproval('cap_r.abc')).toBe(false);
    expect(capabilityHandleNeedsApproval('cap_abc')).toBe(false); // legacy unmarked
    expect(capabilityHandleNeedsApproval(undefined)).toBe(false);
    expect(capabilityHandleNeedsApproval(42)).toBe(false);
  });
});
