// The output guard over the internal route: whole text in, the same reading
// a streamed reply gets out, and the caller keeps its own text on a failure.

import express from 'express';
import request from 'supertest';

const mockGuard = jest.fn();
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { outputGuardRouter } from '../output-guard-router';

const app = express();
app.use('/api/internal/output-guard', express.json(), outputGuardRouter);

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';
const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const THREAD = 'f411a323-d2d2-4984-a4f6-e5b45a232a04';

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockImplementation(async (text: string) =>
    text.includes('per the request')
      ? { text: text.replace(', per the request', ''), changed: true, kinds: ['mechanics'] }
      : { text, changed: false, kinds: [] });
});

describe('POST /api/internal/output-guard', () => {
  it('scrubs, reads paragraph by paragraph, and passes a fence through unread', async () => {
    const res = await request(app).post('/api/internal/output-guard').send({
      tenantId: TENANT,
      speaker: 'caio',
      threadId: THREAD,
      toolNames: ['team_update'],
      text: `Here is the change to "Support Triage" (id ${ID}), per the request.\n\n\`\`\`\nteam_update({ id: "${ID}" })\n\`\`\`\n\nSay yes and I will call team_update.`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      text: 'Here is the change to "Support Triage".\n\n```\n({ id: "" })\n```\n\nSay yes and I will call.',
      changed: true,
    });
    expect(mockGuard.mock.calls.map((c) => c[0])).toEqual([
      'Here is the change to "Support Triage", per the request.',
      'Say yes and I will call.',
    ]);
    expect(mockGuard.mock.calls[0][1]).toEqual({ tenantId: TENANT, speaker: 'caio', threadId: THREAD });
  });

  it('answers changed=false, text byte-identical, when nothing needed reading out', async () => {
    const text = 'Three teams ran this week.';
    const res = await request(app).post('/api/internal/output-guard').send({ tenantId: TENANT, speaker: 'caio', text });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text, changed: false });
  });

  it('refuses a body without a tenant, a speaker or a text', async () => {
    expect((await request(app).post('/api/internal/output-guard').send({ speaker: 'caio', text: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/internal/output-guard').send({ tenantId: TENANT, text: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/internal/output-guard').send({ tenantId: TENANT, speaker: 'caio' })).status).toBe(400);
  });
});
