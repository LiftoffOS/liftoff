// An accepted declaration is not lost to a cold start or a database error.
//
// The cache served the gate from memory, refreshed on a TTL. Two ways for a
// declaration a person had accepted to vanish: on a new instance the first
// governed call for a tenant found an empty entry and started a refresh it
// did not wait for; and the store answered a database error with an empty
// map, which the cache kept as the truth for five minutes — "nothing
// accepted" and "could not ask" were the same answer. Both mean every write
// on that connector judged as if nobody had declared anything, which reads
// as clean.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const acceptedShapesForMock = jest.fn<Promise<Map<string, unknown[]>>, [string]>();
jest.mock('../learned-shapes-store', () => ({
  acceptedShapesFor: (t: string) => acceptedShapesForMock(t),
}));

import { acceptedReturnsIds, ensureAcceptedShapesLoaded, _resetLearnedShapesCacheForTesting } from '../learned-shapes-cache';

const T = '11111111-1111-4111-8111-111111111111';
const ACCEPTED = new Map([['github-dd4c4689.pull_request_read', [{ connectorType: 'github', actionType: 'pull_request_read', path: 'number', entityType: 'pull_request', observedCount: 3, serverAlias: 'github-dd4c4689' }]]]);
const lookup = () => acceptedReturnsIds(T, 'github', 'pull_request_read', 'github-dd4c4689');

beforeEach(() => { _resetLearnedShapesCacheForTesting(); acceptedShapesForMock.mockReset(); });

it('a cold instance’s first governed call waits for the load and sees the accepted paths', async () => {
  acceptedShapesForMock.mockResolvedValue(ACCEPTED);
  await ensureAcceptedShapesLoaded(T);
  expect(lookup()).toEqual([{ entityType: 'pull_request', path: 'number' }]);
  expect(acceptedShapesForMock).toHaveBeenCalledTimes(1);
});

it('waits only up to the bound, then proceeds with what is there while the load continues', async () => {
  let release: (m: Map<string, unknown[]>) => void = () => undefined;
  acceptedShapesForMock.mockImplementation(() => new Promise((r) => { release = r; }));
  await ensureAcceptedShapesLoaded(T, 20);
  expect(lookup()).toEqual([]);
  release(ACCEPTED);
  await new Promise((r) => setTimeout(r, 0));
  expect(lookup()).toEqual([{ entityType: 'pull_request', path: 'number' }]);
});

it('keeps the last known-good set through a database error, and retries', async () => {
  acceptedShapesForMock.mockResolvedValueOnce(ACCEPTED);
  await ensureAcceptedShapesLoaded(T);
  expect(lookup()).toHaveLength(1);
  // The TTL lapses; the refresh fails. Nothing accepted goes missing.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000;
  try {
    acceptedShapesForMock.mockRejectedValueOnce(new Error('connection refused'));
    expect(lookup()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(lookup()).toHaveLength(1);
    // Before the retry interval, no new query; after it, another try, which
    // succeeds and is served.
    expect(acceptedShapesForMock).toHaveBeenCalledTimes(2);
    Date.now = () => realNow() + 6 * 60_000 + 31_000;
    acceptedShapesForMock.mockResolvedValueOnce(new Map());
    lookup();
    await new Promise((r) => setTimeout(r, 0));
    expect(acceptedShapesForMock).toHaveBeenCalledTimes(3);
    expect(lookup()).toEqual([]);
  } finally {
    Date.now = realNow;
  }
});

it('a set that never loaded stays unknown, and is asked for again only after the retry interval', async () => {
  acceptedShapesForMock.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(ACCEPTED);
  await ensureAcceptedShapesLoaded(T);
  expect(lookup()).toEqual([]);
  // Sequential governed calls through the outage do not each query and each
  // wait the bound: the retry time set by the failure is honoured here too.
  await ensureAcceptedShapesLoaded(T);
  await ensureAcceptedShapesLoaded(T);
  expect(acceptedShapesForMock).toHaveBeenCalledTimes(1);
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    await ensureAcceptedShapesLoaded(T);
    expect(acceptedShapesForMock).toHaveBeenCalledTimes(2);
    expect(lookup()).toHaveLength(1);
  } finally {
    Date.now = realNow;
  }
});

it('joins a refresh in progress rather than starting a second', async () => {
  let release: (m: Map<string, unknown[]>) => void = () => undefined;
  acceptedShapesForMock.mockImplementation(() => new Promise((r) => { release = r; }));
  const a = ensureAcceptedShapesLoaded(T);
  const b = ensureAcceptedShapesLoaded(T);
  release(ACCEPTED);
  await Promise.all([a, b]);
  expect(acceptedShapesForMock).toHaveBeenCalledTimes(1);
});
