import { getCompanionCrons } from '../trigger-config-helpers';
import type { TriggerConfig } from '../types';

describe('getCompanionCrons', () => {
  it('returns empty array when triggerConfig is null/undefined', () => {
    expect(getCompanionCrons(null)).toEqual([]);
    expect(getCompanionCrons(undefined)).toEqual([]);
    expect(getCompanionCrons({} as TriggerConfig)).toEqual([]);
  });

  it('returns companionCrons array unchanged when set', () => {
    const tc: TriggerConfig = {
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCrons: [
        { label: 'weekly-summary', cronExpr: '0 9 * * 1' },
        { label: 'monthly-report', cronExpr: '0 9 1 * *', timezone: 'UTC' },
      ],
    };
    expect(getCompanionCrons(tc)).toEqual(tc.companionCrons);
  });

  it('normalizes legacy singular companionCron to default-labeled array entry', () => {
    const tc: TriggerConfig = {
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCron: { cronExpr: '0 9 * * 1', timezone: 'America/Los_Angeles' },
    };
    expect(getCompanionCrons(tc)).toEqual([
      { label: 'default', cronExpr: '0 9 * * 1', timezone: 'America/Los_Angeles' },
    ]);
  });

  it('prefers plural companionCrons over deprecated singular when both present', () => {
    const tc: TriggerConfig = {
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCron: { cronExpr: 'A' },
      companionCrons: [{ label: 'weekly', cronExpr: 'B' }],
    };
    expect(getCompanionCrons(tc)).toEqual([{ label: 'weekly', cronExpr: 'B' }]);
  });
});
