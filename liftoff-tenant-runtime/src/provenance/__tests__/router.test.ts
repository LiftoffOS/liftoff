import request from 'supertest';
import express from 'express';

const mockFindMemoriesByConnector = jest.fn();
const mockPoolQuery = jest.fn();
const mockRequireServiceAuth = jest.fn(() => (_req: any, _res: any, next: any) => next());

jest.mock('../../memory/provenance-service', () => ({
  findMemoriesByConnector: (...args: any[]) => mockFindMemoriesByConnector(...args),
}));

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: any[]) => mockPoolQuery(...args) },
}));

jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => mockRequireServiceAuth(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { provenanceRouter } from '../router';

const app = express();
app.use(express.json());
app.use('/api/internal/provenance', provenanceRouter);

beforeEach(() => jest.clearAllMocks());

describe('DELETE /api/internal/provenance/connector/:connectorId', () => {
  it('returns 400 when tenantId is missing', async () => {
    const res = await request(app)
      .delete('/api/internal/provenance/connector/conn-1')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 when tenantId is not a valid UUID', async () => {
    const res = await request(app)
      .delete('/api/internal/provenance/connector/conn-1')
      .send({ tenantId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns {deleted: 0} and skips DELETE when no memories found', async () => {
    mockFindMemoriesByConnector.mockResolvedValueOnce([]);
    const res = await request(app)
      .delete('/api/internal/provenance/connector/conn-1')
      .send({ tenantId: '00000000-0000-4000-8000-000000000001' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0 });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('bulk deletes memories and returns {deleted: N}', async () => {
    mockFindMemoriesByConnector.mockResolvedValueOnce(['mem-a', 'mem-b', 'mem-c']);
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 3 });
    const tenantId = '00000000-0000-4000-8000-000000000001';

    const res = await request(app)
      .delete('/api/internal/provenance/connector/conn-1')
      .send({ tenantId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 3 });
    expect(mockFindMemoriesByConnector).toHaveBeenCalledWith(tenantId, 'conn-1');
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM memories');
    expect(sql).toContain('ANY($2::uuid[])');
    expect(params).toEqual([tenantId, ['mem-a', 'mem-b', 'mem-c']]);
  });

  it('returns 500 on service error', async () => {
    mockFindMemoriesByConnector.mockRejectedValueOnce(new Error('DB failure'));
    const res = await request(app)
      .delete('/api/internal/provenance/connector/conn-1')
      .send({ tenantId: '00000000-0000-4000-8000-000000000001' });
    expect(res.status).toBe(500);
  });

  it('passes connectorId from URL param correctly', async () => {
    mockFindMemoriesByConnector.mockResolvedValueOnce([]);
    await request(app)
      .delete('/api/internal/provenance/connector/my-connector-id')
      .send({ tenantId: '00000000-0000-4000-8000-000000000001' });
    expect(mockFindMemoriesByConnector).toHaveBeenCalledWith(
      expect.any(String),
      'my-connector-id',
    );
  });
});
