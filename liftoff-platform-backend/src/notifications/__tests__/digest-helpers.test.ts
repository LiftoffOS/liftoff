// Unit tests for digest helper functions (plan §10a:
// "mondayDateInTz called on a Tuesday near midnight tz boundary").

import { mondayDateInTz } from '../digest';

describe('mondayDateInTz', () => {
  it('returns Monday of the current ISO week in UTC for a midweek date', () => {
    // 2026-05-13 is a Wednesday in UTC. Local tz America/Los_Angeles is same week.
    const now = new Date('2026-05-13T18:00:00Z');
    const mon = mondayDateInTz(now, 'America/Los_Angeles');
    expect(mon.toISOString()).toBe('2026-05-11T00:00:00.000Z');
  });

  it('returns the same Monday when called on Monday itself', () => {
    const now = new Date('2026-05-11T15:00:00Z'); // Monday afternoon UTC
    const mon = mondayDateInTz(now, 'America/Los_Angeles');
    expect(mon.toISOString()).toBe('2026-05-11T00:00:00.000Z');
  });

  it('returns the prior Monday when called on Sunday', () => {
    const now = new Date('2026-05-17T15:00:00Z'); // Sunday 15:00 UTC
    const mon = mondayDateInTz(now, 'America/Los_Angeles');
    expect(mon.toISOString()).toBe('2026-05-11T00:00:00.000Z');
  });

  it('handles tz midnight boundary — UTC says next day, local says still today', () => {
    // 2026-05-19T06:00:00Z is Tuesday 06:00 UTC.
    // In Los_Angeles (UTC-7 PDT in May), it's Monday 2026-05-18 23:00 — still Monday locally.
    // Expected ISO-week Monday for that local date: 2026-05-18.
    const now = new Date('2026-05-19T06:00:00Z');
    const mon = mondayDateInTz(now, 'America/Los_Angeles');
    expect(mon.toISOString()).toBe('2026-05-18T00:00:00.000Z');
  });

  it('handles tz midnight boundary — UTC says today, local says already next day', () => {
    // 2026-05-18T23:30:00Z is Monday 23:30 UTC.
    // In Asia/Tokyo (UTC+9), it's Tuesday 2026-05-19 08:30 — local week starts 2026-05-18.
    const now = new Date('2026-05-18T23:30:00Z');
    const mon = mondayDateInTz(now, 'Asia/Tokyo');
    expect(mon.toISOString()).toBe('2026-05-18T00:00:00.000Z');
  });

  it('returns a UTC-midnight Date (hours/min/sec all zero)', () => {
    const mon = mondayDateInTz(new Date('2026-05-13T18:00:00Z'), 'Europe/London');
    expect(mon.getUTCHours()).toBe(0);
    expect(mon.getUTCMinutes()).toBe(0);
    expect(mon.getUTCSeconds()).toBe(0);
  });
});
