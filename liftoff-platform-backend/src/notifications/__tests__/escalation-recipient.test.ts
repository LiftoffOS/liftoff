// escalation_recipient is documented as a prefixed selector, but team-preset
// provisioning validated it as a bare accounts.id and stored it that way. The
// result was that every agent provisioned with an escalation recipient
// escalated to nobody: one consumer logged and dropped it, the other resolved
// an empty recipient list and reported success.
//
// These pin the coercion, including the historical shape, because rows written
// before the fix can hold bare UUIDs.

import {
  normalizeEscalationRecipient,
  DEFAULT_ESCALATION_RECIPIENT,
} from '../escalation-recipient';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('notifications / normalizeEscalationRecipient', () => {
  it('passes through each documented selector unchanged', () => {
    expect(normalizeEscalationRecipient(`user:${UUID}`)).toBe(`user:${UUID}`);
    expect(normalizeEscalationRecipient('role:admin')).toBe('role:admin');
    expect(normalizeEscalationRecipient(`agent:${UUID}`)).toBe(`agent:${UUID}`);
  });

  // The bug: this is what provisioning has actually been writing.
  it('reads a bare account id as that person', () => {
    expect(normalizeEscalationRecipient(UUID)).toBe(`user:${UUID}`);
    expect(normalizeEscalationRecipient(UUID.toUpperCase())).toBe(`user:${UUID.toUpperCase()}`);
  });

  it('trims incidental whitespace before deciding', () => {
    expect(normalizeEscalationRecipient(`  ${UUID}  `)).toBe(`user:${UUID}`);
    expect(normalizeEscalationRecipient('  role:admin ')).toBe('role:admin');
  });

  it('returns null for nothing, so callers must choose a fallback', () => {
    expect(normalizeEscalationRecipient(null)).toBeNull();
    expect(normalizeEscalationRecipient(undefined)).toBeNull();
    expect(normalizeEscalationRecipient('')).toBeNull();
    expect(normalizeEscalationRecipient('   ')).toBeNull();
  });

  // Deliberately null rather than a guess: an escalation sent to the wrong
  // person is worse than one that falls back to the workspace admins.
  it('returns null for anything it cannot recognise', () => {
    expect(normalizeEscalationRecipient('ada@example.com')).toBeNull();
    expect(normalizeEscalationRecipient('admin')).toBeNull();
    expect(normalizeEscalationRecipient('not-a-uuid')).toBeNull();
    expect(normalizeEscalationRecipient('user')).toBeNull();
  });

  it('defaults to the workspace admins, matching migration 256', () => {
    expect(DEFAULT_ESCALATION_RECIPIENT).toBe('role:admin');
  });
});
