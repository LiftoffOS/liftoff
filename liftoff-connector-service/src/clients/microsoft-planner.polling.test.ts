// MicrosoftPlannerClient.list('Task') (GET /me/planner/tasks) + normalizer .results path.

import { MicrosoftPlannerClient } from './microsoft-planner.js';
import { MicrosoftPlannerNormalizer } from '../normalizers/microsoft-planner.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'graph_token',
  instanceUrl: undefined,
  tenantId: 't1',
  connectorId: 'c1',
});

function mockFetchOnce(body: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe('MicrosoftPlannerClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists all assigned tasks via /me/planner/tasks', async () => {
    const spy = mockFetchOnce({
      value: [{ id: 'T1', title: 'Ship reactive polling', planId: 'P1', percentComplete: 0 }],
    });
    const client = new MicrosoftPlannerClient(credentialProvider);
    const res = await client.list('Task', { since: new Date('2026-06-26T00:00:00Z') });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('T1');
    expect(res.hasMore).toBe(false);
    expect(spy.mock.calls[0][0] as string).toContain('/me/planner/tasks');
  });

  it('returns empty for a non-Task entity without calling Graph', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new MicrosoftPlannerClient(credentialProvider);
    expect((await client.list('Plan')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MicrosoftPlannerNormalizer .results polling path', () => {
  it('normalizes scheduler-wrapped { results: [task] } rows to Task records', () => {
    const n = new MicrosoftPlannerNormalizer();
    const recs = n.normalize({
      results: [{
        id: 'T1',
        title: 'Ship reactive polling',
        planId: 'P1',
        bucketId: 'B1',
        percentComplete: 50,
        '@odata.etag': 'W/"etag1"',
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Task');
    expect(recs[0].externalId).toBe('T1');
    expect(recs[0].metadata.source).toBe('microsoft_planner');
  });
});
