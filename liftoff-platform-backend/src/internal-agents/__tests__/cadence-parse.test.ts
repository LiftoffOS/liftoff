// Derive-then-verify: the parser must be conservative (null over a guess),
// and the analyzer check must fail a trigger set that dropped or moved the
// stated cadence while accepting one that widened only the fields the
// distiller owns.

import { cronMatchesExpected, parseCadence, statedChangeAgrees } from '../cadence-parse';
import { checkExpectedCadences, checkStoppedCadences } from '../trigger-config-analyzer';

describe('parseCadence', () => {
  it.each([
    ['Every Friday at 4pm, post the most urgent open item here.', '0 16 * * 5'],
    ['every monday morning at 9am, compile the chase list', '0 9 * * 1'],
    ['Runs every Tuesday at 10:30am.', '30 10 * * 2'],
    ['every day at 8am, sweep the inbox', '0 8 * * *'],
    ['daily at 16:00, check the queue', '0 16 * * *'],
    ['weekdays at 9am, post standup notes', '0 9 * * 1-5'],
    ['every 15 minutes, poll the feed', '*/15 * * * *'],
    ['every 2 hours, refresh the cache', '0 */2 * * *'],
  ])('parses %s', (prose, cron) => {
    expect(parseCadence(prose)).toEqual({ cronExpr: cron });
  });

  it.each([
    ['when something important happens, tell me'],
    ['every Monday, do the thing'], // no time stated
    ['every Friday at 4pm and every Monday at 9am'], // two cadences: never pick
    ['every friday at 25pm'], // nonsense time
    ['soon'],
  ])('returns null rather than guessing for %s', (prose) => {
    expect(parseCadence(prose)).toBeNull();
  });
});

describe('cronMatchesExpected', () => {
  it('requires minute, hour and day-of-week; leaves day-of-month and month to the distiller', () => {
    expect(cronMatchesExpected('0 16 * * 5', '0 16 * * 5')).toBe(true);
    expect(cronMatchesExpected('0 16 1-31 * 5', '0 16 * * 5')).toBe(true);
    expect(cronMatchesExpected('0 16 * * *', '0 16 * * 5')).toBe(false);
    expect(cronMatchesExpected('0 9 * * 5', '0 16 * * 5')).toBe(false);
  });
});

describe('checkExpectedCadences', () => {
  const expected = [{ prose: 'Every Friday at 4pm, post here.', cronExpr: '0 16 * * 5' }];

  it('passes when a companion carries the cadence', () => {
    const trigger = {
      cronExpr: '0 8 * * 1',
      companionCrons: [{ label: 'friday', cronExpr: '0 16 * * 5' }],
    };
    expect(checkExpectedCadences(trigger, expected)).toEqual([]);
  });

  it('rejects when the cadence was dropped or moved', () => {
    const trigger = {
      cronExpr: '0 8 * * 1',
      companionCrons: [{ label: 'friday', cronExpr: '0 16 * * 4' }],
    };
    const violations = checkExpectedCadences(trigger, expected);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'expected_cadence_missing', severity: 'reject' });
  });

  it('checks nothing when nothing was expected', () => {
    expect(checkExpectedCadences({ cronExpr: '0 8 * * 1' }, undefined)).toEqual([]);
  });
});

describe('statedChangeAgrees', () => {
  const MONDAY_8 = '0 8 * * 1';
  const MONDAY_9 = '0 9 * * 1';

  it('passes the change idiom: old time, new time, same day', () => {
    expect(statedChangeAgrees('Change the monday one from 8AM to 9AM', MONDAY_8, MONDAY_9)).toBe(true);
  });

  it('passes a full restated cadence in the words themselves', () => {
    expect(statedChangeAgrees('make it every monday at 9am please', null, MONDAY_9)).toBe(true);
  });

  it('refuses when two candidate new times remain', () => {
    expect(statedChangeAgrees('move it to 9am or maybe 10am', MONDAY_8, MONDAY_9)).toBe(false);
  });

  it('refuses when the stated time is not the proposed one', () => {
    expect(statedChangeAgrees('change the monday one from 8am to 10am', MONDAY_8, MONDAY_9)).toBe(false);
  });

  it('refuses a weekday that contradicts the routine', () => {
    expect(statedChangeAgrees('change the friday one from 8am to 9am', MONDAY_8, MONDAY_9)).toBe(false);
  });

  it('refuses a day move via the idiom (only a full restated cadence moves the day)', () => {
    expect(statedChangeAgrees('move it from 8am to 9am', MONDAY_8, '0 9 * * 2')).toBe(false);
    expect(statedChangeAgrees('make it every tuesday at 9am', MONDAY_8, '0 9 * * 2')).toBe(true);
  });

  it('refuses the idiom with no known current cadence', () => {
    expect(statedChangeAgrees('change it from 8am to 9am', null, MONDAY_9)).toBe(false);
  });

  it('refuses a message with no time at all', () => {
    expect(statedChangeAgrees('make it a bit later on mondays', MONDAY_8, MONDAY_9)).toBe(false);
  });

  it('refuses when there is no proposed cron to agree with', () => {
    expect(statedChangeAgrees('from 8am to 9am', MONDAY_8, null)).toBe(false);
  });
});

describe('checkStoppedCadences', () => {
  const stopped = [
    { prose: 'Every Friday at 10am, send the most urgent open item.', cronExpr: '0 10 * * 5' },
  ];

  it('passes when the stopped cadence is gone from the trigger set', () => {
    const trigger = {
      cronExpr: '0 8 * * 1',
      companionCrons: [{ label: 'midweek', cronExpr: '0 8 * * 4' }],
    };
    expect(checkStoppedCadences(trigger, stopped)).toEqual([]);
  });

  it('rejects when a companion still carries the stopped cadence', () => {
    const trigger = {
      cronExpr: '0 8 * * 1',
      companionCrons: [{ label: 'friday-most-urgent-item', cronExpr: '0 10 * * 5' }],
    };
    const violations = checkStoppedCadences(trigger, stopped);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'stopped_cadence_present', severity: 'reject' });
  });

  it('rejects when the PRIMARY cron carries the stopped cadence', () => {
    const violations = checkStoppedCadences({ cronExpr: '0 10 * * 5' }, stopped);
    expect(violations).toHaveLength(1);
  });

  it('skips an entry with no parsed cron: prose-only stops inform the prompt, not the check', () => {
    const trigger = { cronExpr: '0 8 * * 4' };
    expect(
      checkStoppedCadences(trigger, [{ prose: 'Stop the midweek check routine.' }]),
    ).toEqual([]);
  });

  it('checks nothing when nothing was stopped', () => {
    expect(checkStoppedCadences({ cronExpr: '0 10 * * 5' }, undefined)).toEqual([]);
  });
});
