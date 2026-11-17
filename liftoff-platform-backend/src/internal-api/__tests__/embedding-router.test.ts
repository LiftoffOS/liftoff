// The embedding route's two gates and the shape it returns.
//
// The purpose gate is the one worth pinning: it is what stops a service token
// spending here anonymously, and it is also what keeps the cost on a named
// assistant's line rather than becoming unattributed platform overhead.

const mockEmbed = jest.fn();
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: (...a: unknown[]) => mockEmbed(...a) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../workforce-service-auth', () => ({
  workforceServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import { embeddingInternalRouter } from '../embedding-router';

const TENANT = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/embedding', embeddingInternalRouter);
  return app;
}

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = buildApp().listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}/api/internal/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const parsed = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const VALID = {
  tenantId: TENANT,
  input: 'the invoice chasing team',
  taskType: 'retrieval_document' as const,
  purpose: 'caio_recall_embed',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    provider: 'google',
    model: 'gemini-embedding-001',
  });
});

describe('validation', () => {
  it.each([
    ['tenantId', { ...VALID, tenantId: 'not-a-uuid' }],
    ['input', { ...VALID, input: '' }],
    ['taskType', { ...VALID, taskType: 'classification' }],
  ])('refuses a bad %s', async (_which, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('refuses input longer than the repo-wide embed budget rather than truncating it', async () => {
    // Silently truncating would embed something the caller does not know it
    // stored, and it would never find out.
    const res = await post({ ...VALID, input: 'x'.repeat(4001) });

    expect(res.status).toBe(400);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

describe('the purpose gate', () => {
  it('refuses a purpose this process does not map to an assistant', async () => {
    const res = await post({ ...VALID, purpose: 'something_nobody_registered' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('registered platform-assistant purpose');
    // Refused BEFORE spending: an unattributable embed is never charged.
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('accepts the two the Chief AI Officer uses', async () => {
    for (const purpose of ['caio_recall_embed', 'caio_recall_query']) {
      expect((await post({ ...VALID, purpose })).status).toBe(200);
    }
  });
});

describe('what it returns', () => {
  it('carries the space beside the vector, because a vector alone is not comparable', async () => {
    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      vector: [0.1, 0.2, 0.3],
      provider: 'google',
      model: 'gemini-embedding-001',
      dimensions: 768,
    });
  });

  it('embeds at the width the turns columns are declared at', async () => {
    await post(VALID);

    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ dimensions: 768 }));
  });

  it('attributes the spend to the tenant, the purpose and the row', async () => {
    await post({ ...VALID, itemId: 'turn-1' });

    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({
      context: { tenantId: TENANT, purpose: 'caio_recall_embed', itemId: 'turn-1' },
    }));
  });

  it('answers a provider failure as a bad gateway, never as an empty vector', async () => {
    mockEmbed.mockRejectedValue(new Error('provider is down'));

    const res = await post(VALID);

    expect(res.status).toBe(502);
    expect(res.body.vector).toBeUndefined();
  });
});
