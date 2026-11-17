// The CAIO's rolling-summary client.
//
// This file used to be a stub that returned "Conversation with N messages
// (summary placeholder)" without calling anything, and that string went into the
// thread and then into the prompt. It is now a client for platform-backend's
// summarizer — the one the insights chat and the agent team-chat already share —
// so the properties worth pinning are that it delegates, that it tags the cost
// correctly, and that a failure leaves the existing summary alone rather than
// wiping it.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({
    Authorization: 'Bearer oidc-token',
    'X-Service-Auth': 'workforce-token',
  }),
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import {
  formatSummaryForPrompt,
  isUsableSummary,
  summarizeThread,
  type ConversationSummary,
} from '../workforce-plans/conversation-summarization.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const THREAD = '33333333-3333-3333-3333-333333333333';

const SUMMARY: ConversationSummary = {
  userIntent: 'Designing a grant processing team',
  keyFacts: ['10 grants a month'],
  openQuestions: ['Which verification source'],
  previousFindings: ['Intake is the bottleneck'],
  nextSteps: ['Draft the team'],
  summarizedThrough: '2026-08-05T00:00:00.000Z',
  messageCount: 12,
};

const MESSAGES = [
  { id: 'm1', role: 'user' as const, content: 'we run a DAF', createdAt: '2026-08-05T00:00:00.000Z' },
];

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'https://pb.example.com';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'workforce-token';
  fetchSpy = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetConfigForTests();
});

describe('summarizeThread', () => {
  it('delegates to platform-backend rather than summarizing here', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ summarized: true, summary: SUMMARY, promptText: 'User intent: ...' }),
    } as unknown as Response);

    const result = await summarizeThread({
      tenantId: TENANT,
      threadId: THREAD,
      messages: MESSAGES,
      previousSummary: null,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/internal/chat-summarization');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages).toEqual(MESSAGES);
    // Cost lands in Workforce Planning, not Platform Analytics.
    expect(body.purpose).toBe('caio_workforce_planning_summarization');
    expect(result.summary).toEqual(SUMMARY);
  });

  it('sends the previous summary so the next one extends it', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ summarized: true, summary: SUMMARY, promptText: null }),
    } as unknown as Response);

    await summarizeThread({
      tenantId: TENANT,
      threadId: THREAD,
      messages: MESSAGES,
      previousSummary: SUMMARY,
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.previousSummary).toEqual(SUMMARY);
  });

  it('reports not-summarized on an error rather than throwing into the turn', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const result = await summarizeThread({
      tenantId: TENANT, threadId: THREAD, messages: MESSAGES, previousSummary: SUMMARY,
    });
    // The caller keeps the summary it already has; it must not be cleared.
    expect(result).toEqual({ summarized: false, summary: null, promptText: null });
  });

  it('survives a network failure the same way', async () => {
    fetchSpy.mockRejectedValue(new Error('socket hang up'));
    const result = await summarizeThread({
      tenantId: TENANT, threadId: THREAD, messages: MESSAGES, previousSummary: null,
    });
    expect(result.summarized).toBe(false);
  });
});

describe('isUsableSummary', () => {
  it('accepts a structured summary', () => {
    expect(isUsableSummary(SUMMARY)).toBe(true);
  });

  it('rejects the flat placeholder rows the old stub wrote', () => {
    // Every rolling_summary row predating this change looks like this. Reading
    // them as absent is what regenerates them.
    expect(isUsableSummary({ summary: 'Conversation with 34 messages (summary placeholder)', messageCount: 34 }))
      .toBe(false);
    expect(isUsableSummary(null)).toBe(false);
    expect(isUsableSummary('a string')).toBe(false);
  });
});

describe('formatSummaryForPrompt', () => {
  it('renders the fields the prompt expects and omits empty ones', () => {
    const text = formatSummaryForPrompt({ ...SUMMARY, nextSteps: [] });
    expect(text).toContain('User intent: Designing a grant processing team');
    expect(text).toContain('- 10 grants a month');
    expect(text).toContain('Previous findings:');
    expect(text).not.toContain('Suggested next steps:');
  });
});
