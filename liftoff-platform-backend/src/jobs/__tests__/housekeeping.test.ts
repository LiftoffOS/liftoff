// platform-backend's one Cloud Scheduler job. It must enqueue every entry once
// under a dated name, run the weekly entry only on its day, fail the pass when
// an entry could not be enqueued (so the scheduler alert sees it), and list
// each target once.

const enqueue = jest.fn();

jest.mock('../../infrastructure/maintenance-tasks', () => ({
  enqueueMaintenanceTask: (...a: unknown[]) => enqueue(...a),
  armWatch: jest.fn(),
  armDue: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { dailyHousekeeping, enqueueDailyHousekeeping } from '../housekeeping';

const label = (e: ReturnType<typeof dailyHousekeeping>[number]) => e.path;

beforeEach(() => enqueue.mockReset().mockResolvedValue('enqueued'));

it('lists each target once', () => {
  const labels = dailyHousekeeping().map(label);
  expect(new Set(labels).size).toBe(labels.length);
});

it('enqueues every daily entry under a dated name, twenty seconds apart', async () => {
  const saturday = new Date('2026-11-07T15:00:00Z');
  const result = await enqueueDailyHousekeeping(saturday);
  const daily = dailyHousekeeping().filter((e) => e.weekday === undefined);
  expect(result).toEqual({ day: '20261107', enqueued: daily.length, alreadyArmed: 0, failed: [] });
  const calls = enqueue.mock.calls.map((c) => c[0]);
  expect(calls[0].name).toBe(`hk-20261107-${label(daily[0])}`);
  expect(calls[1].at.getTime() - calls[0].at.getTime()).toBe(20_000);
  // Routes only: a Cloud Run job run from Cloud Tasks is refused by VPC-SC.
  expect(calls.every((t) => typeof t.path === 'string' && t.path.startsWith('/api/'))).toBe(true);
});

it('runs weekly retention on Sundays only', async () => {
  await enqueueDailyHousekeeping(new Date('2026-11-07T15:00:00Z'));
  expect(enqueue.mock.calls.map((c) => c[0].path)).not.toContain('/api/internal/data-management/retention/run-cleanup');
  enqueue.mockClear();
  await enqueueDailyHousekeeping(new Date('2026-11-08T15:00:00Z'));
  expect(enqueue.mock.calls.map((c) => c[0].path)).toContain('/api/internal/data-management/retention/run-cleanup');
});

it('fails the pass when an entry could not be enqueued, after trying the rest', async () => {
  enqueue.mockRejectedValueOnce(new Error('denied'));
  await expect(enqueueDailyHousekeeping(new Date('2026-11-07T15:00:00Z'))).rejects.toThrow(/1 entries not enqueued/);
  expect(enqueue).toHaveBeenCalledTimes(dailyHousekeeping().filter((e) => e.weekday === undefined).length);
});
