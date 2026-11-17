// The tool-gateway SSRF gate engages ONLY when the invocation's content trust is
// untrusted_inbound — the exact state a reactive fire off an external-authored
// connector produces (see reactive-subscriptions fireAgentForSubscription). This
// asserts the trust-gating that couples the reactive-fire path to the SSRF scan.

import { checkSsrfGate } from '../service';
import type { ExecuteInput } from '../types';

function input(overrides: Partial<ExecuteInput>): ExecuteInput {
  return {
    tenantId: 't1',
    agentId: 'a1',
    instructionVersion: 0,
    traceId: 'tr1',
    connector: 'http',
    actionType: 'fetch',
    payload: {},
    ...overrides,
  } as ExecuteInput;
}

describe('tool-gateway SSRF gate — trust coupling', () => {
  const unsafeUrl = 'http://169.254.169.254/latest/meta-data/'; // cloud metadata endpoint

  it('a TRUSTED invocation with an unsafe URL is NOT gated (SSRF scan skipped)', () => {
    const r = checkSsrfGate(input({ trustLevel: 'trusted', payload: { url: unsafeUrl } }));
    expect(r).toBeNull();
  });

  it('an UNTRUSTED invocation with an unsafe URL is REFUSED', () => {
    const r = checkSsrfGate(input({ trustLevel: 'untrusted_inbound', payload: { url: unsafeUrl } }));
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.error).toMatch(/private|metadata|Refused/i);
  });

  it('an UNTRUSTED invocation with a safe URL passes', () => {
    const r = checkSsrfGate(input({ trustLevel: 'untrusted_inbound', payload: { url: 'https://example.com/ok' } }));
    expect(r).toBeNull();
  });

  it('a missing trustLevel defaults to not-gated (trusted)', () => {
    const r = checkSsrfGate(input({ payload: { url: unsafeUrl } }));
    expect(r).toBeNull();
  });
});
