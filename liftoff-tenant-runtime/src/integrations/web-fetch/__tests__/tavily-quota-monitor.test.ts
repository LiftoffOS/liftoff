const mockGetSecret = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: mockLogger,
}));

import { pollTavilyQuota } from '../tavily-quota-monitor';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

const HAPPY_USAGE_FIXTURE = {
  key: { usage: 0, limit: null, search_usage: 0, extract_usage: 0, crawl_usage: 0, map_usage: 0, research_usage: 0 },
  account: {
    current_plan: 'Researcher',
    plan_usage: 0, plan_limit: 1000,
    search_usage: 0, extract_usage: 0, crawl_usage: 0, map_usage: 0, research_usage: 0,
    paygo_usage: 0, paygo_limit: null,
  },
};

function withUsage(overrides: Partial<typeof HAPPY_USAGE_FIXTURE.account>): typeof HAPPY_USAGE_FIXTURE {
  return {
    ...HAPPY_USAGE_FIXTURE,
    account: { ...HAPPY_USAGE_FIXTURE.account, ...overrides },
  };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('tvly-test-key');
});

describe('pollTavilyQuota', () => {
  it('happy path: 0% util → no warn log emitted', async () => {
    mockFetch(200, HAPPY_USAGE_FIXTURE);
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(0);
  });

  it('below threshold: 50% util → no warn log emitted', async () => {
    mockFetch(200, withUsage({ plan_usage: 500, plan_limit: 1000 }));
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(0);
  });

  it('80% boundary: fires tavily_quota_high', async () => {
    mockFetch(200, withUsage({ plan_usage: 800, plan_limit: 1000 }));
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(1);
  });

  it('above threshold: fires tavily_quota_high at 95%', async () => {
    mockFetch(200, withUsage({ plan_usage: 950, plan_limit: 1000 }));
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(1);
  });

  it('defensive plan_limit<=0 fallback uses RESEARCHER_PLAN_CREDITS_TOTAL=1000; 800 usage fires', async () => {
    mockFetch(200, withUsage({ plan_usage: 800, plan_limit: 0 }));
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(1);
    const payload = quotaWarns[0][0] as { credits_total: number };
    expect(payload.credits_total).toBe(1000);
  });

  it('API non-2xx (401): logs warn, returns silently (no throw)', async () => {
    mockFetch(401, { error: 'unauthorized' });
    await expect(pollTavilyQuota()).resolves.toBeUndefined();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('API non-2xx (500): logs warn, returns silently', async () => {
    mockFetch(500, { error: 'server' });
    await expect(pollTavilyQuota()).resolves.toBeUndefined();
  });

  it('network error: logs warn, returns silently', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    await expect(pollTavilyQuota()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('missing API key: returns silently without calling fetch', async () => {
    mockGetSecret.mockResolvedValueOnce('');
    const fetchFn = jest.fn();
    global.fetch = fetchFn as unknown as typeof fetch;
    await expect(pollTavilyQuota()).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('log payload includes util_pct, credits_used, credits_total, plan, search_usage, extract_usage', async () => {
    mockFetch(200, withUsage({
      plan_usage: 900, plan_limit: 1000,
      search_usage: 700, extract_usage: 200,
    }));
    await pollTavilyQuota();
    const quotaWarns = mockLogger.warn.mock.calls.filter(c => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'tavily_quota_high';
    });
    expect(quotaWarns).toHaveLength(1);
    const payload = quotaWarns[0][0] as {
      event: string;
      util_pct: number;
      credits_used: number;
      credits_total: number;
      plan: string;
      search_usage: number;
      extract_usage: number;
    };
    expect(payload.event).toBe('tavily_quota_high');
    expect(payload.util_pct).toBe(90);
    expect(payload.credits_used).toBe(900);
    expect(payload.credits_total).toBe(1000);
    expect(payload.plan).toBe('Researcher');
    expect(payload.search_usage).toBe(700);
    expect(payload.extract_usage).toBe(200);
  });
});
