// The registry snapshot keys context windows the way the runtime looks them up.
//
// Two columns named `provider` used to mean different things: `models.provider`
// was a registry VENDOR key and `model_pricing.provider` the EXECUTION provider,
// while the runtime keys BOTH feeds `provider:model` and looks them up by the
// second. Four of the five open-weights vendors missed. Only GLM hit, because
// its rows happened to be filed under 'openrouter' — which is why the gap read
// as working.
//
// Migration 450 collapsed the two into one vocabulary, so the mapping below is
// an identity for every current row. It is kept, and tested, because a row can
// still arrive under the old key — a backup restored, a script not yet updated
// — and because the property being asserted is the one that matters: whatever
// `models.provider` says, the snapshot goes out keyed the way the runtime asks.
//
// A miss here is silent and consequential: the reading degrades to a
// provider-family FLOOR, floors understate every long-window model, and
// `mayDriveRetirement` refuses to act on a floor at all. The window path goes
// quietly inert for the vendors it covers.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { modelRegistryInternalRouter } from '../model-registry-internal-router';

const app = express();
app.use('/api/internal/model-registry', modelRegistryInternalRouter);

/** The FOUR queries the handler runs, in order: pricing, branding, windows, and
 *  the platform vendor policy.
 *
 *  Ordered mocks are why the count matters: a handler that grew a query would
 *  get `undefined` back from the fourth call, throw on `.rows`, and answer 500 —
 *  which reads as the snapshot being broken rather than as the mock being one
 *  short. A trailing catch-all keeps this honest if another feed is added, so a
 *  future query fails on its own assertion rather than on this helper. */
function respondWith(windowRows: Array<{ provider: string; model_id: string; context_window: number }>) {
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [] } as never)
    .mockResolvedValueOnce({ rows: [] } as never)
    .mockResolvedValueOnce({ rows: windowRows } as never)
    .mockResolvedValue({ rows: [] } as never);
}

async function windowsFor(rows: Array<{ provider: string; model_id: string; context_window: number }>) {
  respondWith(rows);
  const res = await request(app).get('/api/internal/model-registry');
  expect(res.status).toBe(200);
  return (res.body as { windows: Array<{ provider: string; model_id: string }> }).windows;
}

describe('registry snapshot: context-window provider', () => {
  it('sends each family under the provider it executes on', async () => {
    const windows = await windowsFor([
      { provider: 'glm', model_id: 'z-ai/glm-5.2', context_window: 1_048_576 },
      { provider: 'qwen', model_id: 'qwen/qwen3.8-max-0902', context_window: 1_000_000 },
      { provider: 'kimi', model_id: 'moonshotai/kimi-k3', context_window: 1_048_576 },
      { provider: 'deepseek', model_id: 'deepseek/deepseek-v4-pro', context_window: 1_048_576 },
      // The one vendor whose key is not its provider: 'xai' is the company and
      // 'grok' the model line, and the runtime has asked under 'xai' since
      // migration 417.
      { provider: 'grok', model_id: 'grok-4.6', context_window: 500_000 },
    ]);
    expect(windows.map((w) => w.provider)).toEqual(['glm', 'qwen', 'kimi', 'deepseek', 'xai']);
  });

  it('leaves a provider that is not a vendor key alone', async () => {
    const windows = await windowsFor([
      // The gateway's name, which a row written before migration 450 can still
      // carry. It is not a family, so there is nothing to map it to — the
      // runtime asks under 'glm' and this row simply does not answer.
      { provider: 'openrouter', model_id: 'z-ai/glm-5.2', context_window: 1_048_576 },
      { provider: 'anthropic', model_id: 'claude-opus-5', context_window: 1_000_000 },
      { provider: 'vertex-ai', model_id: 'gemini-3.1-pro', context_window: 1_000_000 },
    ]);
    expect(windows.map((w) => w.provider)).toEqual(['openrouter', 'anthropic', 'vertex-ai']);
  });

  it('carries the model id and window through untouched', async () => {
    const windows = await windowsFor([
      { provider: 'grok', model_id: 'grok-4.6', context_window: 500_000 },
    ]);
    expect(windows[0]).toMatchObject({ model_id: 'grok-4.6', context_window: 500_000 });
  });
});
