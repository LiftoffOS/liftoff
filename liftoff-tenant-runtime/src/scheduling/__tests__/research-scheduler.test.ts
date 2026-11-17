// Phase 6: Unit tests for the research-scheduler per-agent interval
// gating. We test the pure helpers (getAgentResearchIntervalDays,
// getSchedulerTickMs, isAgentDueForResearch) directly — the
// runResearchJobs orchestrator has too many heavy dependencies (thread
// creation, agent execution, pool) to unit-test cleanly, and it's
// covered indirectly by the helpers that carry its decision logic.

import {
  getAgentResearchIntervalDays,
  getSchedulerTickMs,
  isAgentDueForResearch,
  DEFAULT_RESEARCH_INTERVAL_DAYS,
} from '../research-scheduler';

describe('getAgentResearchIntervalDays', () => {
  it('returns the default when exec_config is null or undefined', () => {
    expect(getAgentResearchIntervalDays(null)).toBe(DEFAULT_RESEARCH_INTERVAL_DAYS);
    expect(getAgentResearchIntervalDays(undefined)).toBe(DEFAULT_RESEARCH_INTERVAL_DAYS);
  });

  it('returns the default when research_interval_days is missing', () => {
    expect(getAgentResearchIntervalDays({})).toBe(DEFAULT_RESEARCH_INTERVAL_DAYS);
  });

  it('honours a valid positive override', () => {
    expect(getAgentResearchIntervalDays({ research_interval_days: 7 })).toBe(7);
    expect(getAgentResearchIntervalDays({ research_interval_days: 90 })).toBe(90);
  });

  it('falls back to default on zero, negative, or non-numeric values', () => {
    expect(getAgentResearchIntervalDays({ research_interval_days: 0 })).toBe(
      DEFAULT_RESEARCH_INTERVAL_DAYS,
    );
    expect(getAgentResearchIntervalDays({ research_interval_days: -5 })).toBe(
      DEFAULT_RESEARCH_INTERVAL_DAYS,
    );
    expect(
      getAgentResearchIntervalDays({ research_interval_days: 'thirty' as any }),
    ).toBe(DEFAULT_RESEARCH_INTERVAL_DAYS);
    expect(
      getAgentResearchIntervalDays({ research_interval_days: NaN }),
    ).toBe(DEFAULT_RESEARCH_INTERVAL_DAYS);
  });
});

describe('getSchedulerTickMs', () => {
  const originalEnv = process.env.RESEARCH_SCHEDULER_TICK_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RESEARCH_SCHEDULER_TICK_MS;
    } else {
      process.env.RESEARCH_SCHEDULER_TICK_MS = originalEnv;
    }
  });

  it('returns the 24h default when env var is unset', () => {
    delete process.env.RESEARCH_SCHEDULER_TICK_MS;
    expect(getSchedulerTickMs()).toBe(24 * 60 * 60 * 1000);
  });

  it('honours a valid env override', () => {
    process.env.RESEARCH_SCHEDULER_TICK_MS = '60000';
    expect(getSchedulerTickMs()).toBe(60_000);
  });

  it('falls back to default on non-numeric or non-positive env values', () => {
    const fallback = 24 * 60 * 60 * 1000;

    process.env.RESEARCH_SCHEDULER_TICK_MS = 'daily';
    expect(getSchedulerTickMs()).toBe(fallback);

    process.env.RESEARCH_SCHEDULER_TICK_MS = '0';
    expect(getSchedulerTickMs()).toBe(fallback);

    process.env.RESEARCH_SCHEDULER_TICK_MS = '-5000';
    expect(getSchedulerTickMs()).toBe(fallback);
  });
});

describe('isAgentDueForResearch', () => {
  const TENANT = 'tenant-x';
  const AGENT = 'agent-y';
  const NOW = new Date('2026-04-12T12:00:00Z');

  it('returns true when no prior research thread exists', async () => {
    const queryLatestResearchThread = jest.fn().mockResolvedValue(null);

    const due = await isAgentDueForResearch(TENANT, AGENT, 30, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(true);
    expect(queryLatestResearchThread).toHaveBeenCalledWith(TENANT, AGENT);
  });

  it('returns true when the last thread is older than interval', async () => {
    // Last thread 31 days ago — longer than the 30-day interval.
    const oldTimestamp = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    const queryLatestResearchThread = jest
      .fn()
      .mockResolvedValue({ created_at: oldTimestamp });

    const due = await isAgentDueForResearch(TENANT, AGENT, 30, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(true);
  });

  it('returns false when the last thread is more recent than interval', async () => {
    // Last thread 10 days ago — shorter than the 30-day interval.
    const recentTimestamp = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const queryLatestResearchThread = jest
      .fn()
      .mockResolvedValue({ created_at: recentTimestamp });

    const due = await isAgentDueForResearch(TENANT, AGENT, 30, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(false);
  });

  it('honours a shorter custom interval (e.g. weekly research agent)', async () => {
    // Last thread 8 days ago — longer than a 7-day interval.
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const queryLatestResearchThread = jest
      .fn()
      .mockResolvedValue({ created_at: eightDaysAgo });

    const due = await isAgentDueForResearch(TENANT, AGENT, 7, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(true);
  });

  it('returns false for a weekly agent whose last run is 3 days old', async () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const queryLatestResearchThread = jest
      .fn()
      .mockResolvedValue({ created_at: threeDaysAgo });

    const due = await isAgentDueForResearch(TENANT, AGENT, 7, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(false);
  });

  it('is due at exactly the interval boundary', async () => {
    // Exactly 30 days ago — should be due (elapsed >= interval).
    const exactly30DaysAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const queryLatestResearchThread = jest
      .fn()
      .mockResolvedValue({ created_at: exactly30DaysAgo });

    const due = await isAgentDueForResearch(TENANT, AGENT, 30, {
      queryLatestResearchThread,
      now: () => NOW,
    });

    expect(due).toBe(true);
  });
});
