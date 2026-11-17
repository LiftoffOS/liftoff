// The digest tick runs only at the hours someone's clock reads 09:00. Getting
// the next such hour wrong means a digest that never goes out, so the
// arithmetic is pinned here: whole and half-hour offsets, several zones, and
// a timezone the runtime does not know.

jest.mock('../../jobs/maintenance-targets', () => ({ armDigestTick: jest.fn() }));

import { nextDigestHour, armNextDigest } from '../digest-schedule';
import { armDigestTick } from '../../jobs/maintenance-targets';

const NOW = new Date('2026-11-08T07:10:00Z'); // PST (UTC-8) in November

it('finds the next 09:00 in one timezone', () => {
  expect(nextDigestHour(['America/Los_Angeles'], NOW)?.toISOString()).toBe('2026-11-08T17:00:00.000Z');
});

it('takes the earliest of several', () => {
  // 09:00 in London (UTC+0 in November) is 09:00Z, before Los Angeles.
  expect(nextDigestHour(['America/Los_Angeles', 'Europe/London'], NOW)?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
});

it('handles a half-hour offset the way the tick reads it (09:30 local)', () => {
  // Asia/Kolkata is UTC+5:30; 04:00Z reads 09:30, hour 9.
  expect(nextDigestHour(['Asia/Kolkata'], NOW)?.toISOString()).toBe('2026-11-09T04:00:00.000Z');
});

it('is strictly after now: a tick at 09:00 arms tomorrow, not itself', () => {
  expect(nextDigestHour(['Europe/London'], new Date('2026-11-08T09:01:00Z'))?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
});

it('reads an empty or unknown timezone as the default', () => {
  expect(nextDigestHour([null, 'Not/AZone'], NOW)?.toISOString()).toBe('2026-11-08T17:00:00.000Z');
});

it('arms nothing with no timezones', () => {
  expect(nextDigestHour([], NOW)).toBeNull();
  armNextDigest([], NOW);
  expect(armDigestTick).not.toHaveBeenCalled();
  armNextDigest(['America/Los_Angeles'], NOW);
  expect(armDigestTick).toHaveBeenCalledWith(new Date('2026-11-08T17:00:00.000Z'));
});
