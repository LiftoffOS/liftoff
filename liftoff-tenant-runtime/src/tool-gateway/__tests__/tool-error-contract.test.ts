// Phase 7 last-hop fix: the tool-gateway MCP server must surface the
// authoritative tool-error contract from a *thrown* connector failure — whether
// it arrived as a ToolExecutionError (native / connector-service) or a
// NormalizedToolError (composio overlay) — so the model envelope AND the
// /activity audit anchor to the origin-computed code, not a message heuristic.

import { extractToolErrorContract } from '../tool-error-contract';
import { ToolExecutionError } from '../types';
import { defaultComposioErrorMap } from '@liftoffos/composio-overlays';

describe('extractToolErrorContract', () => {
  it('extracts the full contract from a ToolExecutionError (native path)', () => {
    const err = new ToolExecutionError('token expired', {
      code: 'auth_expired',
      retryable: false,
      recovery: 'Reconnect the connector.',
      message: 'token expired',
    });
    expect(extractToolErrorContract(err)).toEqual({
      code: 'auth_expired',
      retryable: false,
      retryAfterMs: undefined,
      recovery: 'Reconnect the connector.',
      message: 'token expired',
    });
  });

  it('carries retryAfterMs off a ToolExecutionError', () => {
    const err = new ToolExecutionError('slow down', {
      code: 'rate_limited', retryable: true, retryAfterMs: 1500, recovery: 'wait', message: 'slow down',
    });
    expect(extractToolErrorContract(err)?.retryAfterMs).toBe(1500);
  });

  it('extracts the code from a REAL composio NormalizedToolError (404 → not_found)', () => {
    // This is the common path — dispatchComposio throws exactly this shape.
    const normalized = defaultComposioErrorMap({ code: -32404, message: 'Not Found' });
    const c = extractToolErrorContract(normalized);
    expect(c?.code).toBe('not_found');
    expect(c?.retryable).toBe(false);
    expect(c?.message).toBe('Not Found');
    // NormalizedToolError carries no recovery text — left for the code-derived
    // default (recoveryFor) inside buildToolErrorContent.
    expect(c?.recovery).toBeUndefined();
  });

  it('carries retryAfterMs off a composio 429 NormalizedToolError', () => {
    const normalized = defaultComposioErrorMap({
      code: -32429, message: 'Too Many Requests', data: { retry_after: 3 },
    });
    const c = extractToolErrorContract(normalized);
    expect(c?.code).toBe('rate_limited');
    expect(c?.retryable).toBe(true);
    expect(c?.retryAfterMs).toBe(3000); // vendor Retry-After 3s → ms
  });

  it('returns undefined for a raw infra Error (caller falls back to heuristic)', () => {
    expect(extractToolErrorContract(new Error('ECONNRESET'))).toBeUndefined();
  });

  it('returns undefined for an Error whose .code is not a ToolErrorCode', () => {
    const e = Object.assign(new Error('weird'), { code: 'bogus_code' });
    expect(extractToolErrorContract(e)).toBeUndefined();
  });

  it('returns undefined for non-Error throwables (no false positives)', () => {
    expect(extractToolErrorContract('string error')).toBeUndefined();
    // A plain object matching the shape but NOT an Error must not qualify.
    expect(extractToolErrorContract({ code: 'not_found', message: 'x' })).toBeUndefined();
    expect(extractToolErrorContract(undefined)).toBeUndefined();
    expect(extractToolErrorContract(null)).toBeUndefined();
  });
});
