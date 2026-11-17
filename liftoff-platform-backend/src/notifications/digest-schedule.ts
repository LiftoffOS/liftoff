// When the digest tick runs next.
//
// The tick sends a digest to the accounts whose local clock reads 09:00 at
// that moment, so it ran at the top of every UTC hour to catch every timezone,
// 24 runs a day for the handful of hours anyone's 09:00 falls on. It now runs
// only at those hours: each tick arms the next hour in which some candidate's
// clock reads 09:00, a newly queued digest row arms its account's next 09:00,
// and the daily housekeeping pass runs the tick once to re-arm the chain if it
// was ever lost.

import { armDigestTick } from '../jobs/maintenance-targets';

export const DIGEST_HOUR = 9; // 09:00 local
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

function localHour(at: Date, timezone: string): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(at),
    10,
  );
}

/** The first top-of-the-UTC-hour strictly after `now` at which any of these
 *  timezones reads DIGEST_HOUR, or null for no timezones. An unknown timezone
 *  is read as the default one, as the tick reads it. */
export function nextDigestHour(timezones: Iterable<string | null | undefined>, now: Date): Date | null {
  const zones = new Set<string>();
  for (const tz of timezones) {
    const zone = tz || DEFAULT_TIMEZONE;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      zones.add(zone);
    } catch {
      zones.add(DEFAULT_TIMEZONE);
    }
  }
  if (zones.size === 0) return null;
  const firstHour = Math.floor(now.getTime() / 3_600_000) + 1;
  // 25 hours covers every offset, including half-hour ones, which read
  // DIGEST_HOUR at a top-of-the-UTC-hour too (09:30 local), as the tick does.
  for (let h = firstHour; h <= firstHour + 25; h++) {
    const at = new Date(h * 3_600_000);
    for (const zone of zones) {
      if (localHour(at, zone) === DIGEST_HOUR) return at;
    }
  }
  return null;
}

/** Arm the tick for the next 09:00 of any of these timezones. */
export function armNextDigest(timezones: Iterable<string | null | undefined>, now: Date = new Date()): void {
  const next = nextDigestHour(timezones, now);
  if (next) armDigestTick(next);
}
