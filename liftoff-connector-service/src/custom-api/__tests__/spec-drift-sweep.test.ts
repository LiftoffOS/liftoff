/**
 * The sweep notices that a provider's API moved, and does nothing about it.
 *
 * Detecting is the whole job. Applying a re-read REPLACES a connection's
 * operations, and one the provider has dropped goes with them — an AI team
 * bound to it loses it — so that stays a person's call. A sweep that helpfully
 * applied what it found would remove tools from teams overnight with nobody
 * having asked.
 *
 * The other half is that a provider having a bad afternoon is not drift. A
 * specification that cannot be fetched must not be recorded as a change, and
 * must not consume the connection's re-check window: the read did not happen,
 * so the next cycle tries again rather than waiting out a day on a 503.
 */
const listMock = jest.fn();
const recordMock = jest.fn();
const fetchMock = jest.fn();
const replaceOpsMock = jest.fn();
const mergeConfigMock = jest.fn();

jest.mock('../repository.js', () => ({
  listCustomApiConnectionsToCheck: (...a: unknown[]) => listMock(...a),
  recordCustomApiSpecCheck: (...a: unknown[]) => recordMock(...a),
  replaceCustomApiOperations: (...a: unknown[]) => replaceOpsMock(...a),
}));
jest.mock('../../oauth/connector-ops.js', () => ({
  mergeConnectorConfig: (...a: unknown[]) => mergeConfigMock(...a),
}));
jest.mock('../spec-fetch.js', () => ({
  fetchOpenApiDocument: (...a: unknown[]) => fetchMock(...a),
  SpecFetchError: class SpecFetchError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
}));
jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CustomApiSpecDriftSweep } from '../spec-drift-sweep.js';

function candidate(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    specSourceUrl: 'https://api.acme.example/openapi.json',
    specHash: 'built-from-this',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the specification drift sweep', () => {
  it('records the hash that is there now when the provider has moved, and changes nothing else', async () => {
    listMock.mockResolvedValue([candidate()]);
    fetchMock.mockResolvedValue({ hash: 'something-else', document: {} });

    const read = await new CustomApiSpecDriftSweep().sweepOnce();

    expect(read).toBe(1);
    expect(recordMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
      driftHash: 'something-else',
    });
    // The operations are the person's to replace, never the sweep's.
    expect(replaceOpsMock).not.toHaveBeenCalled();
    // And onto the connector row, because the CARD is where it is noticed.
    expect(mergeConfigMock).toHaveBeenCalledWith('tenant-1', 'conn-1', { specDrifted: true });
  });

  it('clears the card when the provider turns out not to have moved', async () => {
    listMock.mockResolvedValue([candidate()]);
    fetchMock.mockResolvedValue({ hash: 'built-from-this', document: {} });

    await new CustomApiSpecDriftSweep().sweepOnce();

    expect(mergeConfigMock).toHaveBeenCalledWith('tenant-1', 'conn-1', { specDrifted: false });
  });

  it('records the same hash when nothing moved, so an up-to-date connection reads as no drift', async () => {
    listMock.mockResolvedValue([candidate()]);
    fetchMock.mockResolvedValue({ hash: 'built-from-this', document: {} });

    await new CustomApiSpecDriftSweep().sweepOnce();

    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ driftHash: 'built-from-this' }),
    );
  });

  it('records nothing when the specification cannot be read, leaving the window open for the next cycle', async () => {
    listMock.mockResolvedValue([candidate()]);
    fetchMock.mockRejectedValue(new Error('503 from the provider'));

    const read = await new CustomApiSpecDriftSweep().sweepOnce();

    // Not read, so not counted, and `checked_at` never moved: a provider
    // having a bad afternoon is not the same as a connection being current.
    expect(read).toBe(0);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('carries on past one connection it cannot read', async () => {
    listMock.mockResolvedValue([candidate(), candidate({ connectorId: 'conn-2' })]);
    fetchMock
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce({ hash: 'moved', document: {} });

    const read = await new CustomApiSpecDriftSweep().sweepOnce();

    expect(read).toBe(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-2' }));
  });

  it('asks only for connections not read lately, and bounds a cycle', async () => {
    listMock.mockResolvedValue([]);

    await new CustomApiSpecDriftSweep(1000, '24 hours', 50).sweepOnce();

    expect(listMock).toHaveBeenCalledWith({ notCheckedFor: '24 hours', limit: 50 });
  });

  it('gives up the cycle rather than throwing when the connections cannot be listed', async () => {
    listMock.mockRejectedValue(new Error('database is having a moment'));

    await expect(new CustomApiSpecDriftSweep().sweepOnce()).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
