// The internal summarization endpoint.
//
// Its whole reason to exist is that workforce-service must run *this* code
// rather than its own. So the tests worth having are that it delegates to the
// shared module untouched, that the threshold decision stays on this side, and
// that a caller cannot get in without the service token.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockShouldSummarize = jest.fn();
const mockGenerateRollingSummary = jest.fn();
const mockFormatSummaryForPrompt = jest.fn();
jest.mock('../insights/conversation-summarization', () => ({
  shouldSummarize: (...a: unknown[]) => mockShouldSummarize(...a),
  generateRollingSummary: (...a: unknown[]) => mockGenerateRollingSummary(...a),
  formatSummaryForPrompt: (...a: unknown[]) => mockFormatSummaryForPrompt(...a),
}));

import { chatSummarizationInternalRouter } from './chat-summarization-router';

const TOKEN = 'workforce-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const THREAD_ID = '33333333-3333-3333-3333-333333333333';

const SUMMARY = {
  userIntent: 'Designing a grant processing team',
  keyFacts: ['10 grants a month'],
  openQuestions: ['Which charity verification source'],
  previousFindings: [],
  nextSteps: ['Draft the team'],
  summarizedThrough: '2026-08-05T00:00:00.000Z',
  messageCount: 12,
};

const MESSAGES = [
  { id: 'm1', role: 'user' as const, content: 'we run a DAF', createdAt: '2026-08-05T00:00:00.000Z' },
  { id: 'm2', role: 'assistant' as const, content: 'tell me more', createdAt: '2026-08-05T00:00:01.000Z' },
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/chat-summarization', chatSummarizationInternalRouter);
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/chat-summarization`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-auth': token } : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const VALID_BODY = {
  tenantId: TENANT_ID,
  threadId: THREAD_ID,
  messages: MESSAGES,
  previousSummary: null,
  purpose: 'caio_workforce_planning_summarization',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  mockShouldSummarize.mockReturnValue(true);
  mockGenerateRollingSummary.mockResolvedValue(SUMMARY);
  mockFormatSummaryForPrompt.mockReturnValue('User intent: Designing a grant processing team');
});

afterEach(() => {
  delete process.env['WORKFORCE_SERVICE_TOKEN'];
});

describe('POST /api/internal/chat-summarization', () => {
  it('401s without the service token, without summarizing', async () => {
    const res = await post(buildApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockGenerateRollingSummary).not.toHaveBeenCalled();
  });

  it('delegates to the shared summarizer and returns its structured output', async () => {
    const res = await post(buildApp(), VALID_BODY, TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      summarized: true,
      summary: SUMMARY,
      promptText: 'User intent: Designing a grant processing team',
    });
    // The point of the endpoint: the caller's messages reach the shared module
    // unchanged, and the caller's purpose tag rides along for cost attribution.
    const input = mockGenerateRollingSummary.mock.calls[0][0];
    expect(input.allMessages).toEqual(MESSAGES);
    expect(input.tenantId).toBe(TENANT_ID);
    expect(input.purpose).toBe('caio_workforce_planning_summarization');
  });

  it('keeps the threshold decision on this side', async () => {
    // Otherwise every consumer reimplements "is it time yet", which is how the
    // CAIO ended up with its own thresholds and its own stub.
    mockShouldSummarize.mockReturnValue(false);

    const res = await post(buildApp(), VALID_BODY, TOKEN);

    expect(res.body).toEqual({ summarized: false, summary: null, promptText: null });
    expect(mockGenerateRollingSummary).not.toHaveBeenCalled();
  });

  it('threads a previous summary through so it extends rather than restarts', async () => {
    await post(buildApp(), { ...VALID_BODY, previousSummary: SUMMARY }, TOKEN);
    expect(mockGenerateRollingSummary.mock.calls[0][0].previousSummary).toEqual(SUMMARY);
  });

  it('reports not-summarized when the shared module falls back to nothing', async () => {
    mockGenerateRollingSummary.mockResolvedValue(null);
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.body).toEqual({ summarized: false, summary: null, promptText: null });
  });

  it('400s on a malformed body', async () => {
    const res = await post(buildApp(), { tenantId: 'nope' }, TOKEN);
    expect(res.status).toBe(400);
    expect(mockGenerateRollingSummary).not.toHaveBeenCalled();
  });
});
