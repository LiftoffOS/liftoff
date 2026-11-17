// A platform assistant that did work appears everywhere work is shown.
//
// The three assistants were invisible on every activity surface at once, and
// the reason was structural rather than a filter anyone could have spotted:
// `getAuditLogAggregation` builds its roster from `internal_agents UNION
// external_agents`, and an assistant has a row in NEITHER table — that is what
// makes it a platform assistant. They also write no audit rows, so a
// workspace's audit rows all carry an agent and none record the assistants'
// turns of real work.
//
// So `AI Workforce Activity`, `Task Volume` and `Tasks Completed` all read as
// though Liftoff, the Insights Manager and the Chief AI Officer had done
// nothing at all — on a page whose entire job is showing what the AI workforce
// did. This pins all three surfaces together: an assistant with work is on the
// chart, in the trend, and in the card, or this fails.

import { getAssistantActivity } from '../data-providers/assistant-activity-provider';
import { assistantForPurpose, ASSISTANT_LABELS } from '../platform-assistants';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = 'tenant-1';
const RANGE = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-30T00:00:00Z') };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('getAssistantActivity', () => {
  it('folds every purpose onto the assistant that owns it', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { purpose: 'liftoff_chat',            date: '2026-09-01', count: '10' },
        { purpose: 'liftoff_summarization',   date: '2026-09-01', count: '2' },
        { purpose: 'caio_workforce_planning', date: '2026-09-02', count: '7' },
        { purpose: 'insights_intro',          date: '2026-09-02', count: '3' },
      ],
    });

    const activity = await getAssistantActivity(TENANT, RANGE, 'day');
    const byKey = new Map(activity.map(a => [a.assistant, a]));

    // A chat turn and the rolling summary of that same conversation are both
    // Liftoff working; they are one bar, not two.
    expect(byKey.get('liftoff')!.actionCount).toBe(12);
    expect(byKey.get('caio')!.actionCount).toBe(7);
    // The Insights Manager's page-load work counts. It produces no message, so
    // counting turns would have missed it entirely.
    expect(byKey.get('insights')!.actionCount).toBe(3);
  });

  it('counts work the platform ABSORBS, because it still happened', async () => {
    // The activity chart must not move when a pricing policy changes. Absorbed
    // purposes book customer_cost_usd=0 in cost_bucket='platform_overhead';
    // a bucket filter here would silently empty the chart the day something
    // became free.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAssistantActivity(TENANT, RANGE, 'day');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('cost_bucket');
  });

  it('drops a purpose that belongs to no assistant rather than guessing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ purpose: 'some_platform_internal_thing', date: '2026-09-01', count: '99' }],
    });
    expect(await getAssistantActivity(TENANT, RANGE, 'day')).toEqual([]);
  });

  it('returns nothing on a query error rather than failing the page', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    expect(await getAssistantActivity(TENANT, RANGE, 'day')).toEqual([]);
  });

  it('keeps a per-bucket series so the trend can add it to the AI segment', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { purpose: 'liftoff_chat', date: '2026-09-02', count: '4' },
        { purpose: 'liftoff_chat', date: '2026-09-01', count: '6' },
      ],
    });
    const [liftoff] = await getAssistantActivity(TENANT, RANGE, 'day');
    expect(liftoff.actionCount).toBe(10);
    expect(liftoff.timeBreakdown.map(b => b.count)).toEqual([6, 4]);   // sorted by date
  });
});

describe('every assistant the cost page can name, the activity page can name', () => {
  // The two halves are driven by the same map. If a purpose reaches the Cost
  // Breakdown under an assistant's name, its work has to reach the activity
  // chart under that same name — otherwise a workspace sees an assistant
  // spending money while apparently doing nothing.
  it('shares one purpose-to-assistant map', () => {
    for (const purpose of [
      'liftoff_chat', 'liftoff_summarization',
      'insights_chat', 'insights_summarization', 'insights_intro', 'insights_observation',
      'caio_workforce_planning', 'caio_workforce_planning_summarization',
      'caio_workforce_planning_title_generation',
    ]) {
      const key = assistantForPurpose(purpose);
      expect(key).not.toBeNull();
      expect(ASSISTANT_LABELS[key!]).toBeTruthy();
    }
  });

  it('names all three, so none can be quietly dropped', () => {
    expect(Object.keys(ASSISTANT_LABELS).sort()).toEqual(['caio', 'insights', 'liftoff']);
  });
});
