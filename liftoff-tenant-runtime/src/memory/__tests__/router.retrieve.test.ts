// Validates the retrieve route's input schema. The body of the route is
// mocked away; we exercise the zod gating.

import express, { json } from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const mockRetrieve = jest.fn().mockResolvedValue([]);
jest.mock('../service', () => ({
  memoryService: { retrieveMemories: (...a: unknown[]) => mockRetrieve(...a) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// router.ts uses provenance-service for the /:id/provenance route — out
// of scope for our tests, mock the import.
jest.mock('../provenance-service', () => ({
  getProvenanceChain: jest.fn(),
}));

// Skip the redactor too (only invoked by GET /:id; we test POST /retrieve).
jest.mock('../redactor', () => ({
  redactCredentials: jest.fn((s: string) => ({ redacted: s })),
}));

// The router carries requireServiceAuth(), so every request needs the shared
// secret. Exercised rather than mocked away — the guard is the only thing
// standing between these routes and an unauthenticated caller.
const SERVICE_TOKEN = 'test-service-token';
process.env.TENANT_RUNTIME_SERVICE_TOKEN = SERVICE_TOKEN;

import { memoryRouter } from '../router';

const app = express();
app.use(json());
app.use((req, _res, next) => {
  (req as any).ctx = { tenantId: '12345678-1234-4234-8234-123456789aaa' };
  next();
});
app.use('/api/memory', memoryRouter);

const post = (path: string) =>
  request(app).post(path).set('X-Service-Auth', SERVICE_TOKEN);

beforeEach(() => mockRetrieve.mockClear());

it('rejects an unauthenticated request', async () => {
  const res = await request(app)
    .post('/api/memory/retrieve')
    .send({ query: 'hello' });
  expect(res.status).toBe(401);
  expect(mockRetrieve).not.toHaveBeenCalled();
});

it('rejects layers:["conversation"] with 400', async () => {
  const res = await post('/api/memory/retrieve')
    .send({ query: 'hello', layers: ['conversation'] });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Validation failed');
  expect(mockRetrieve).not.toHaveBeenCalled();
});

it('accepts layers:["global","role"]', async () => {
  const res = await post('/api/memory/retrieve')
    .send({ query: 'hello', layers: ['global', 'role'] });
  expect(res.status).toBe(200);
  expect(mockRetrieve).toHaveBeenCalledWith(
    expect.objectContaining({ layers: ['global', 'role'] }),
  );
});

it('threadId triggers conversation-layer retrieval without listing it in layers', async () => {
  const res = await post('/api/memory/retrieve')
    .send({
      query: 'hello',
      threadId: '12345678-1234-4234-8234-123456789abc',
    });
  expect(res.status).toBe(200);
  expect(mockRetrieve).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: '12345678-1234-4234-8234-123456789abc' }),
  );
});
