// Document-tool failures must classify by the ACTUAL connector-service HTTP
// status — not collapse everything into "connector_auth_required" (which used to
// tell users to re-authorize for a 404/500/timeout). connectorRestError maps the
// status into the tool-error contract; the document-tools MCP wrapper renders it
// as the uniform TOOL_ERROR envelope.

import { connectorRestError, CONNECTOR_AUTH_ERROR } from '../document-tool-handlers';
import { formatToolErrorEnvelope, parseToolErrorEnvelope } from '../tool-error-envelope';

describe('connectorRestError — accurate document-tool error classification', () => {
  it('maps genuine auth/inactive statuses (401/403/409) to auth_expired', () => {
    for (const s of [401, 403, 409]) {
      expect(connectorRestError(s).code).toBe('auth_expired');
    }
  });

  it('maps 404 to not_found (a missing file/op is NOT an auth problem)', () => {
    expect(connectorRestError(404).code).toBe('not_found');
  });

  it('maps 429 to rate_limited', () => {
    expect(connectorRestError(429).code).toBe('rate_limited');
  });

  it('maps upstream 5xx and thrown/network failures (no status) to vendor_unavailable', () => {
    expect(connectorRestError(502).code).toBe('vendor_unavailable');
    expect(connectorRestError(503).code).toBe('vendor_unavailable');
    expect(connectorRestError(504).code).toBe('vendor_unavailable');
    expect(connectorRestError().code).toBe('vendor_unavailable');
  });

  it('maps 500 to internal_error, because that one is ours', () => {
    // connector-service returning 500 means our own request path failed. The
    // same call made again fails the same way, so calling it temporary spends
    // another run to learn nothing and tells the person waiting to retry when
    // they should be telling somebody.
    expect(connectorRestError(500).code).toBe('internal_error');
    expect(connectorRestError(500).error).toBe('connector_internal_error');
  });

  it('does not advertise a 500 as retryable', () => {
    const e = connectorRestError(500);
    const parsed = parseToolErrorEnvelope(
      formatToolErrorEnvelope({ message: e.message, code: e.code }),
    )!;
    expect(parsed.retryable).toBe(false);
  });

  it('still advertises a genuine upstream outage as retryable', () => {
    const e = connectorRestError(503);
    const parsed = parseToolErrorEnvelope(
      formatToolErrorEnvelope({ message: e.message, code: e.code }),
    )!;
    expect(parsed.retryable).toBe(true);
  });

  it('CONNECTOR_AUTH_ERROR is a genuine auth_expired classified error', () => {
    expect(CONNECTOR_AUTH_ERROR.code).toBe('auth_expired');
    expect(CONNECTOR_AUTH_ERROR.error).toBe('connector_auth_required');
  });

  it('each classified error round-trips through the TOOL_ERROR envelope with its code', () => {
    const e = connectorRestError(404);
    const parsed = parseToolErrorEnvelope(formatToolErrorEnvelope({ message: e.message, code: e.code }))!;
    expect(parsed).not.toBeNull();
    expect(parsed.code).toBe('not_found');
    expect(parsed.retryable).toBe(false);
  });
});
