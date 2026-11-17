// PUT /api/model-registry/:id/context-window — the write path the column
// shipped without.
//
// `models.context_window` was settable on INSERT and nowhere else, so every
// model approved before the column existed stayed NULL forever. That is not a
// cosmetic gap: the runtime labels a reading from the registry `registry` and
// one derived from a provider family `provider_floor`, and only the first is
// allowed to end a session. A catalog of NULLs means the whole per-model window
// path is inert, which is what these tests exist to stop happening again.

import { jest } from '@jest/globals';

const mockSetContextWindow = jest.fn();

jest.mock('../service', () => ({
  ModelRegistryService: jest.fn().mockImplementation(() => ({
    setContextWindow: (...args: unknown[]) => mockSetContextWindow(...args),
  })),
}));

jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockLogAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import express from 'express';
import request from 'supertest';
import { modelRegistryRouter } from '../router';

const app = express();
app.use(express.json());
app.use('/api/model-registry', modelRegistryRouter);

const MODEL_ID = '22222222-2222-2222-2222-222222222222';

function modelRow(contextWindow: number | undefined) {
  return {
    id: MODEL_ID,
    name: 'Claude Opus 5',
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    contextWindow,
    status: 'approved',
    capabilities: [],
  };
}

beforeEach(() => {
  mockSetContextWindow.mockReset();
  mockLogAudit.mockReset();
});

describe('PUT /:id/context-window', () => {
  it('records a window and returns the updated model', async () => {
    mockSetContextWindow.mockResolvedValue(modelRow(1_000_000) as never);

    const res = await request(app)
      .put(`/api/model-registry/${MODEL_ID}/context-window`)
      .send({ contextWindow: 1_000_000 });

    expect(res.status).toBe(200);
    expect(res.body.contextWindow).toBe(1_000_000);
    expect(mockSetContextWindow).toHaveBeenCalledWith(MODEL_ID, 1_000_000);
  });

  it('writes an audit entry carrying the recorded window', async () => {
    mockSetContextWindow.mockResolvedValue(modelRow(1_000_000) as never);

    await request(app)
      .put(`/api/model-registry/${MODEL_ID}/context-window`)
      .send({ contextWindow: 1_000_000 });

    expect(mockLogAudit).toHaveBeenCalledWith(
      'model.context_window_set',
      undefined,
      expect.objectContaining({ modelId: MODEL_ID, contextWindow: 1_000_000 }),
    );
  });

  // Clearing is a real operation, not a validation failure: it puts the model
  // back to "unrecorded", which the runtime handles by falling back to a floor.
  it('accepts null to clear a recorded window', async () => {
    mockSetContextWindow.mockResolvedValue(modelRow(undefined) as never);

    const res = await request(app)
      .put(`/api/model-registry/${MODEL_ID}/context-window`)
      .send({ contextWindow: null });

    expect(res.status).toBe(200);
    expect(mockSetContextWindow).toHaveBeenCalledWith(MODEL_ID, null);
  });

  it('404s rather than reporting a write that touched no row', async () => {
    mockSetContextWindow.mockResolvedValue(null as never);

    const res = await request(app)
      .put('/api/model-registry/00000000-0000-0000-0000-000000000000/context-window')
      .send({ contextWindow: 1_000_000 });

    expect(res.status).toBe(404);
  });

  it.each([
    ['a string', 'lots'],
    ['undefined', undefined],
  ])('400s on %s rather than coercing it', async (_label, value) => {
    const res = await request(app)
      .put(`/api/model-registry/${MODEL_ID}/context-window`)
      .send({ contextWindow: value });

    expect(res.status).toBe(400);
    expect(mockSetContextWindow).not.toHaveBeenCalled();
  });

  // The service throws for a non-positive or fractional window. That is the
  // caller's mistake and must not surface as a 500, or an operator typo reads
  // as a platform fault.
  it('400s when the service rejects the value', async () => {
    mockSetContextWindow.mockRejectedValue(
      new Error('contextWindow must be a positive integer, or null to clear it') as never,
    );

    const res = await request(app)
      .put(`/api/model-registry/${MODEL_ID}/context-window`)
      .send({ contextWindow: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('positive integer');
  });
});
