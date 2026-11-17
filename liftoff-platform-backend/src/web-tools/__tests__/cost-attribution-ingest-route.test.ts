/**
 * The hourly cost pass runs inside the scheduled request, and nowhere else.
 *
 * It used to be three timers in index.ts (ingest and the auto-reload sweep
 * every two minutes, the snapshot hourly). Under request-based CPU a timer
 * runs only while some unrelated request is in flight, and the two-minute
 * ingest was what kept three always-allocated services awake with no
 * customers. So the properties worth pinning are that every step runs, in
 * order, that one failing does not skip the rest, and that the request does
 * not answer while a reload call it fired is still in flight.
 */
import express from 'express';
import request from 'supertest';

const order: string[] = [];
const runAllIngestersMock = jest.fn();
const runAutoReloadSweepMock = jest.fn();
const runSnapshotServiceMock = jest.fn();
const settlePendingAutoReloadsMock = jest.fn();

jest.mock('../../cost-attribution/ingestion/ingest-runner', () => ({
  runAllIngesters: (...a: unknown[]) => runAllIngestersMock(...a),
}));
jest.mock('../../billing/auto-reload-sweep', () => ({
  runAutoReloadSweep: (...a: unknown[]) => runAutoReloadSweepMock(...a),
}));
jest.mock('../../cost-attribution/snapshot-service', () => ({
  runSnapshotService: (...a: unknown[]) => runSnapshotServiceMock(...a),
}));
jest.mock('../../cost-attribution/reload-drain', () => ({
  settlePendingAutoReloads: (...a: unknown[]) => settlePendingAutoReloadsMock(...a),
}));
jest.mock('../vendor-spend-monitor', () => ({ monitorVendorSpend: jest.fn() }));
jest.mock('../vendor-reconciliation', () => ({ reconcileVendorSpend: jest.fn() }));

import { webToolsJobsRouter } from '../router';

const TOKEN = 'test-callback-token';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/internal/jobs', webToolsJobsRouter);
  return a;
}

const post = () =>
  request(app()).post('/api/internal/jobs/cost-attribution-ingest').set('X-Service-Auth', TOKEN);

beforeEach(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  order.length = 0;
  runAllIngestersMock.mockReset().mockImplementation(async () => { order.push('ingest'); return { events: 3 }; });
  runAutoReloadSweepMock.mockReset().mockImplementation(async () => { order.push('sweep'); return 0; });
  runSnapshotServiceMock.mockReset().mockImplementation(async () => { order.push('snapshot'); return { hours: 48, days: 2 }; });
  settlePendingAutoReloadsMock.mockReset().mockImplementation(async () => { order.push('settle'); });
});

it('runs ingest, the sweep and the snapshot in order, then settles reloads before answering', async () => {
  const res = await post();
  expect(res.status).toBe(200);
  expect(order).toEqual(['ingest', 'sweep', 'snapshot', 'settle']);
  expect(res.body.ingest).toEqual({ ok: true, result: { events: 3 } });
});

it('does not answer until the reload calls it fired have settled', async () => {
  let release: () => void = () => undefined;
  settlePendingAutoReloadsMock.mockImplementation(() => new Promise<void>((r) => { release = r; }));
  let answered = false;
  const pending = post().then((r) => { answered = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  expect(answered).toBe(false);
  release();
  expect((await pending).status).toBe(200);
});

it('runs every step when one fails, and reports the failure as a 500', async () => {
  runAllIngestersMock.mockImplementation(async () => { order.push('ingest'); throw new Error('feed down'); });
  const res = await post();
  expect(order).toEqual(['ingest', 'sweep', 'snapshot', 'settle']);
  expect(res.status).toBe(500);
  expect(res.body.ingest).toEqual({ ok: false, error: 'feed down' });
  expect(res.body.snapshot.ok).toBe(true);
});

it('refuses a caller without the service token and runs nothing', async () => {
  const res = await request(app()).post('/api/internal/jobs/cost-attribution-ingest');
  expect(res.status).toBe(401);
  expect(order).toEqual([]);
});

describe('scope', () => {
  const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

  it('reads every feed when the body is empty, as the daily pass sends it', async () => {
    await post().send({});
    expect(runAllIngestersMock).toHaveBeenCalledWith({});
  });

  it('narrows the ingest to the sources and workspace a spend signal named', async () => {
    const res = await post().send({ sources: ['runtime', 'sandbox'], tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(runAllIngestersMock).toHaveBeenCalledWith({ sources: ['runtime', 'sandbox'], tenantId: TENANT });
  });

  it.each([
    ['an unknown source', { sources: ['everything'] }],
    ['an empty source list', { sources: [] }],
    ['a workspace id that is not one', { tenantId: 'liftoffos' }],
  ])('refuses %s with a 400 and runs nothing', async (_label, body) => {
    const res = await post().send(body);
    expect(res.status).toBe(400);
    expect(order).toEqual([]);
  });
});
