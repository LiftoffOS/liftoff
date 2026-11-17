// One retry, and only where a second attempt could differ.
//
// This lookup can time out at 5s while connector-service is mid-poll. A GET is
// idempotent and a transient timeout is what a retry is for.
//
// The cases that must NOT retry matter more than the one that does: a 404 is an
// ANSWER, and this function's contract already separates "the connector does
// not exist" from "the lookup failed". Retrying a 404 turns a fast correct null
// into a slow one.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// NOTE: headers are rebuilt per attempt — `buildConnectorServiceHeaders` is
// called inside `attempt()`, so a retry never rides a stale signed identity.
// That is NOT asserted here: the function is private to the client module and a
// test cannot observe it. A test that claims to check something it cannot see is
// worse than no test, so this says it in words and leaves the guarantee to the
// code's shape.

import { getConnectorOwner } from '../connector-service-client';

const OWNER = { tenantId: 'tenant-1', connectorType: 'github', status: 'active' };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, text: async () => '' };
const serverError = { ok: false, status: 503, text: async () => 'busy' };
const forbidden = { ok: false, status: 403, text: async () => 'nope' };

describe('getConnectorOwner retries once, for the right reasons', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONNECTOR_SERVICE_URL = 'https://connector.example';
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('retries a timeout and succeeds', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    fetchMock.mockRejectedValueOnce(timeout).mockResolvedValueOnce(ok(OWNER));

    await expect(getConnectorOwner('c-1')).resolves.toEqual(OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx — the service failed on its side', async () => {
    fetchMock.mockResolvedValueOnce(serverError).mockResolvedValueOnce(ok(OWNER));
    await expect(getConnectorOwner('c-1')).resolves.toEqual(OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 404, because that is an answer', async () => {
    fetchMock.mockResolvedValueOnce(notFound);
    await expect(getConnectorOwner('c-1')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 4xx, which would be refused identically', async () => {
    fetchMock.mockResolvedValue(forbidden);
    await expect(getConnectorOwner('c-1')).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after ONE retry rather than hammering a struggling service', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    await expect(getConnectorOwner('c-1')).rejects.toThrow(/socket hang up/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a success', async () => {
    fetchMock.mockResolvedValueOnce(ok(OWNER));
    await expect(getConnectorOwner('c-1')).resolves.toEqual(OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
