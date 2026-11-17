/**
 * classifyEnsureError — pins the (vendor error) → (proto EnsureSessionError.Kind)
 * mapping so the frontend's copy branches stay stable. New kinds get added by
 * extending both the classifier AND this test in lockstep.
 */
import { EnsureSessionError_Kind } from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { classifyEnsureError } from '../ensure-error-classifier';
import { AnchorError } from '../../integrations/web-fetch/anchor-client';
import { BYOKVendorError } from '../../integrations/web-fetch/types';

describe('classifyEnsureError — AnchorError', () => {
  it('classifies network failures (statusCode 0) as ANCHOR_UNAVAILABLE', () => {
    const result = classifyEnsureError(new AnchorError('Network: ETIMEDOUT', 0));
    expect(result?.kind).toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
  });

  it('classifies 5xx as ANCHOR_UNAVAILABLE', () => {
    expect(classifyEnsureError(new AnchorError('Anchor 503', 503))?.kind)
      .toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
    expect(classifyEnsureError(new AnchorError('Anchor 502', 502))?.kind)
      .toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
  });

  it('classifies 401/403 as INVALID_KEY', () => {
    expect(classifyEnsureError(new AnchorError('Anchor 401', 401))?.kind)
      .toBe(EnsureSessionError_Kind.INVALID_KEY);
    expect(classifyEnsureError(new AnchorError('Anchor 403', 403))?.kind)
      .toBe(EnsureSessionError_Kind.INVALID_KEY);
  });

  it('classifies 402 as QUOTA_EXCEEDED', () => {
    expect(classifyEnsureError(new AnchorError('Anchor 402', 402))?.kind)
      .toBe(EnsureSessionError_Kind.QUOTA_EXCEEDED);
  });

  it('classifies 429 as ANCHOR_UNAVAILABLE (retryable)', () => {
    expect(classifyEnsureError(new AnchorError('Anchor 429', 429))?.kind)
      .toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
  });

  it('classifies other 4xx as UNKNOWN', () => {
    expect(classifyEnsureError(new AnchorError('Anchor 418', 418))?.kind)
      .toBe(EnsureSessionError_Kind.UNKNOWN);
  });

  it('preserves the upstream message verbatim', () => {
    const r = classifyEnsureError(new AnchorError('Anchor 402: out of credits', 402));
    expect(r?.message).toBe('Anchor 402: out of credits');
  });
});

describe('classifyEnsureError — BYOKVendorError', () => {
  const makeBYOK = (code: 'insufficient_funds' | 'invalid_key' | 'rate_limited' | 'vendor_down') =>
    new BYOKVendorError(code, 'anchor_browser', 't', 'cid', `byok ${code}`);

  it('classifies insufficient_funds as QUOTA_EXCEEDED', () => {
    expect(classifyEnsureError(makeBYOK('insufficient_funds'))?.kind)
      .toBe(EnsureSessionError_Kind.QUOTA_EXCEEDED);
  });

  it('classifies invalid_key as INVALID_KEY', () => {
    expect(classifyEnsureError(makeBYOK('invalid_key'))?.kind)
      .toBe(EnsureSessionError_Kind.INVALID_KEY);
  });

  it('classifies rate_limited / vendor_down as ANCHOR_UNAVAILABLE', () => {
    expect(classifyEnsureError(makeBYOK('rate_limited'))?.kind)
      .toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
    expect(classifyEnsureError(makeBYOK('vendor_down'))?.kind)
      .toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
  });
});

describe('classifyEnsureError — unclassified', () => {
  it('returns null for a plain Error (so caller rethrows as Internal)', () => {
    expect(classifyEnsureError(new Error('db pool exhausted'))).toBeNull();
  });

  it('returns null for non-Error values', () => {
    expect(classifyEnsureError('oops')).toBeNull();
    expect(classifyEnsureError(undefined)).toBeNull();
    expect(classifyEnsureError(null)).toBeNull();
  });
});

describe('classifyEnsureError — SteelError', () => {
  // The platform's first-choice pane vendor, on the same status rules as the
  // other two, so a Steel spawn failure reaches the pane as a typed envelope
  // rather than an unclassified 500.
  const { SteelError } = jest.requireActual('../../integrations/web-fetch/steel-client');
  const kindOf = (status: number) => classifyEnsureError(new SteelError('x', status))?.kind;

  it('maps a spend refusal to QUOTA_EXCEEDED', () => {
    expect(kindOf(402)).toBe(EnsureSessionError_Kind.QUOTA_EXCEEDED);
  });
  it('maps a rejected key to INVALID_KEY', () => {
    expect(kindOf(401)).toBe(EnsureSessionError_Kind.INVALID_KEY);
    expect(kindOf(403)).toBe(EnsureSessionError_Kind.INVALID_KEY);
  });
  it('maps the concurrency ceiling and outages to a retryable kind', () => {
    expect(kindOf(429)).toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
    expect(kindOf(503)).toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
    expect(kindOf(0)).toBe(EnsureSessionError_Kind.ANCHOR_UNAVAILABLE);
  });
  it('still types what it cannot name', () => {
    expect(kindOf(418)).toBe(EnsureSessionError_Kind.UNKNOWN);
  });
});
