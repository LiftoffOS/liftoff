// A flush carries what THIS interval saw, and each read counts once.
//
// The observations were a set, copied on every flush and never cleared: one
// read of a path was written again every five minutes for the life of the
// process, the table's counter going up by one each time, until a single
// anomalous response looked like hundreds of independent reads — while a
// hundred real reads inside one interval collapsed into one. The counter is
// meant to tell a fluke from a shape, and it could tell neither.
//
// So the pending store counts per path, the flush persists the counts as a
// delta, and on success takes exactly what it persisted back out — never a
// clear, so a read observed while the write was in flight survives it.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const persistMock = jest.fn<Promise<number>, [string, Record<string, Record<string, number>>]>();
jest.mock('../learned-shapes-store', () => ({ persistObservedShapes: (t: string, o: Record<string, Record<string, number>>) => persistMock(t, o) }));

import { observeReadShape, pendingShapeCountsForTenant, _resetObservedShapesForTesting } from '../observed-shapes';
import { logger } from '../../infrastructure/logging';
import { flushObservedShapes, flushAllObservedShapes, startLearnedShapeFlush, stopLearnedShapeFlush, _stopLearnedShapeFlushForTesting } from '../learned-shapes-flush';

const T = '11111111-1111-4111-8111-111111111111';
const TOOL = 'github-dd4c4689.pull_request_read';
const read = () => observeReadShape(TOOL, { number: 123, head: { sha: 'abc' } }, T);

beforeEach(() => { _resetObservedShapesForTesting(); _stopLearnedShapeFlushForTesting(); persistMock.mockReset(); jest.clearAllMocks(); });

it('counts each read of a path, and a flush persists the count as a delta', async () => {
  read(); read(); read();
  expect(pendingShapeCountsForTenant(T)).toEqual({ [TOOL]: { number: 3, 'head.sha': 3 } });
  persistMock.mockResolvedValue(2);
  await flushObservedShapes(T);
  expect(persistMock).toHaveBeenCalledWith(T, { [TOOL]: { number: 3, 'head.sha': 3 } });
});

it('drains what it persisted, so the next flush carries nothing it already wrote', async () => {
  read();
  persistMock.mockResolvedValue(2);
  await flushObservedShapes(T);
  expect(pendingShapeCountsForTenant(T)).toEqual({});
  persistMock.mockClear();
  await flushObservedShapes(T);
  expect(persistMock).not.toHaveBeenCalled();
});

it('keeps a read observed while the write was in flight', async () => {
  read();
  persistMock.mockImplementation(async () => { read(); return 2; });
  await flushObservedShapes(T);
  // The two writes of the first read are drained; the read that arrived
  // during the write is still pending, once.
  expect(pendingShapeCountsForTenant(T)).toEqual({ [TOOL]: { number: 1, 'head.sha': 1 } });
});

it('keeps everything when the write failed, to carry it next time', async () => {
  read(); read();
  persistMock.mockResolvedValue(0);
  await flushObservedShapes(T);
  expect(pendingShapeCountsForTenant(T)).toEqual({ [TOOL]: { number: 2, 'head.sha': 2 } });
});

describe('one flush at a time, and one more at shutdown', () => {
  it('a flush that finds one in progress joins it, so a delta is never persisted twice', async () => {
    read();
    let release: (n: number) => void = () => undefined;
    persistMock.mockImplementation(() => new Promise((r) => { release = r; }));
    const first = flushAllObservedShapes();
    const second = flushAllObservedShapes();
    release(2);
    await Promise.all([first, second]);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(pendingShapeCountsForTenant(T)).toEqual({});
  });

  it('shutdown stops the timer and writes what is pending', async () => {
    startLearnedShapeFlush();
    read(); read();
    persistMock.mockResolvedValue(2);
    const final = await stopLearnedShapeFlush();
    expect(final).toEqual({ outcome: 'flushed', written: 2 });
    expect(logger.info).toHaveBeenCalledWith({ written: 2 }, 'learned_shapes_final_flush');
    expect(persistMock).toHaveBeenCalledWith(T, { [TOOL]: { number: 2, 'head.sha': 2 } });
    expect(pendingShapeCountsForTenant(T)).toEqual({});
  });

  it('shutdown writes an observation that arrived after the in-flight flush took its snapshot', async () => {
    // Joining the flush in progress is not enough: it persists the snapshot it
    // took before it started. The read below arrives after that snapshot and
    // before the process exits; a stop that only joined left it pending.
    read();
    let release: (n: number) => void = () => undefined;
    persistMock.mockImplementationOnce(() => new Promise((r) => { release = r; })).mockResolvedValue(2);
    const inFlight = flushAllObservedShapes();
    const stopping = stopLearnedShapeFlush();
    read();
    release(2);
    await inFlight;
    await expect(stopping).resolves.toEqual({ outcome: 'flushed', written: 2 });
    expect(persistMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenLastCalledWith(T, { [TOOL]: { number: 1, 'head.sha': 1 } });
    expect(pendingShapeCountsForTenant(T)).toEqual({});
  });

  it('shutdown does not wait past its bound for a store that is not answering, and WARNS', async () => {
    // A bound that expired is not a count. Reported through the count's
    // line, the one case that deserved a warning read as an informational
    // entry with `-1` in it.
    read();
    persistMock.mockImplementation(() => new Promise(() => undefined));
    await expect(stopLearnedShapeFlush(20)).resolves.toEqual({ outcome: 'timed_out', boundMs: 20 });
    expect(logger.warn).toHaveBeenCalledWith({ boundMs: 20 }, expect.stringContaining('learned_shapes_final_flush_timed_out'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'learned_shapes_final_flush');
  });

  it('a store that refuses the final flush is a failure, reported as one', async () => {
    read();
    persistMock.mockRejectedValue(new Error('connection refused'));
    await expect(stopLearnedShapeFlush(200)).resolves.toEqual({ outcome: 'failed', error: 'connection refused' });
    expect(logger.warn).toHaveBeenCalledWith({ err: 'connection refused' }, 'learned_shapes_final_flush_failed');
  });
});

it('the final flush runs after the HTTP server has closed, so nothing can arrive behind it', () => {
  const { readFileSync } = jest.requireActual<typeof import('fs')>('fs');
  const { join } = jest.requireActual<typeof import('path')>('path');
  const src = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
  const closed = src.indexOf("logger.info({ message: 'HTTP server closed' });");
  const flushed = src.indexOf('await stopLearnedShapeFlush()');
  expect(closed).toBeGreaterThan(0);
  expect(flushed).toBeGreaterThan(closed);
  expect(src.slice(0, closed)).not.toContain('stopLearnedShapeFlush()');
});

