// The daily pass is the one Cloud Scheduler job left. It must enqueue every
// entry under a dated name, stagger them, run the weekly entry only on its
// day, report a failed enqueue as a failure, and list only routes that exist —
// a listed path nothing mounts would 404 every day as quietly as the
// scheduler jobs it replaced once did.

const enqueue = jest.fn();

jest.mock('../../infrastructure/maintenance-tasks', () => {
  const actual = jest.requireActual('../../infrastructure/maintenance-tasks');
  return { ...actual, enqueueMaintenanceTask: (...a: unknown[]) => enqueue(...a) };
});
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { DAILY_HOUSEKEEPING, enqueueDailyHousekeeping } from '../housekeeping';

beforeEach(() => enqueue.mockReset().mockResolvedValue('enqueued'));

it('enqueues every daily entry under a dated name, thirty seconds apart', async () => {
  const sunday = new Date('2026-11-08T09:00:00Z');
  const result = await enqueueDailyHousekeeping(sunday);

  const daily = DAILY_HOUSEKEEPING.filter((e) => e.weekday === undefined);
  expect(result).toEqual({ day: '20261108', enqueued: daily.length, alreadyArmed: 0, failed: [] });
  const calls = enqueue.mock.calls.map((c) => c[0]);
  expect(calls.map((t) => t.path)).toEqual(daily.map((e) => e.path));
  expect(calls[0].name).toBe(`hk-20261108-${daily[0].path}`);
  expect(calls[1].at.getTime() - calls[0].at.getTime()).toBe(30_000);
  expect(calls.find((t) => t.path === '/api/internal/connector-tool-smoke').body).toEqual({ allBuckets: true });
  expect(calls.find((t) => t.path === '/api/v1/execution-environments/gc-sweep').target).toBe('sandbox-executor');
});

it('runs the weekly snapshot on Mondays only', async () => {
  await enqueueDailyHousekeeping(new Date('2026-11-09T09:00:00Z'));
  expect(enqueue.mock.calls.map((c) => c[0].path)).toContain('/api/internal/performance-snapshot-tick');
});

it('counts a re-run the same day as already armed, not as new work', async () => {
  enqueue.mockResolvedValue('already-armed');
  const result = await enqueueDailyHousekeeping(new Date('2026-11-08T09:00:00Z'));
  expect(result.enqueued).toBe(0);
  expect(result.alreadyArmed).toBeGreaterThan(0);
});

it('fails the pass when an entry could not be enqueued, after trying the rest', async () => {
  enqueue.mockRejectedValueOnce(new Error('denied'));
  await expect(enqueueDailyHousekeeping(new Date('2026-11-08T09:00:00Z'))).rejects.toThrow(/1 entries not enqueued/);
  expect(enqueue).toHaveBeenCalledTimes(DAILY_HOUSEKEEPING.filter((e) => e.weekday === undefined).length);
});

it('lists only /api/internal routes the cron router actually mounts', () => {
  const router = require('../internal-cron-handler').default as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  };
  const mounted = new Set(
    router.stack.filter((l) => l.route?.methods.post).map((l) => `/api/internal${l.route!.path}`),
  );
  const internal = DAILY_HOUSEKEEPING.map((e) => e.path).filter((p) => p.startsWith('/api/internal/'));
  expect(internal.filter((p) => !mounted.has(p))).toEqual([]);
  // The one Scheduler job's own route.
  expect(mounted.has('/api/internal/housekeeping/daily')).toBe(true);
});
