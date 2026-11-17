// AsanaClient.list('Task') (static_oauth REST polling) + normalizer tests.
//
// list() makes two calls: GET /users/me to resolve the default workspace, then
// GET /tasks?assignee=me&workspace={gid}. Both are mocked via global.fetch.

import { AsanaClient } from './asana.js';
import { AsanaNormalizer } from '../normalizers/asana.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'asana_test_token',
  tenantId: 't1',
  connectorId: 'c1',
});

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('AsanaClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the workspace then hits /tasks with modified_since + assignee=me', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      // 1st call — GET /users/me
      .mockResolvedValueOnce(mockResponse({ data: { gid: 'u1', workspaces: [{ gid: 'ws_42' }] } }))
      // 2nd call — GET /tasks
      .mockResolvedValueOnce(
        mockResponse({
          data: [
            { gid: '1001', name: 'Ship polling', completed: false, modified_at: '2026-06-26T10:00:00.000Z' },
          ],
          next_page: null,
        }),
      );

    const client = new AsanaClient(credentialProvider);
    const res = await client.list('Task', { since: new Date('2026-06-26T00:00:00Z'), limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('1001');
    expect(res.hasMore).toBe(false);
    expect(res.nextPageToken).toBeUndefined();

    // Verify the /users/me resolution call fired first.
    expect(spy.mock.calls[0][0] as string).toContain('/users/me');

    // Verify the tasks endpoint + scope + incremental filter.
    const tasksUrl = spy.mock.calls[1][0] as string;
    expect(tasksUrl).toContain('/api/1.0/tasks');
    expect(tasksUrl).toContain('assignee=me');
    expect(tasksUrl).toContain('workspace=ws_42');
    expect(tasksUrl).toContain('modified_since=2026-06-26T00%3A00%3A00.000Z');
  });

  it('surfaces next_page.offset as nextPageToken and passes it back as offset', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse({ data: { workspaces: [{ gid: 'ws_42' }] } }))
      .mockResolvedValueOnce(
        mockResponse({ data: [{ gid: '1' }], next_page: { offset: 'eyJvZmZzZXQiOjF9' } }),
      );

    const client = new AsanaClient(credentialProvider);
    const res = await client.list('Task', { limit: 1 });
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('eyJvZmZzZXQiOjF9');
  });

  it('returns empty for a non-Task entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new AsanaClient(credentialProvider);
    expect((await client.list('Project')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AsanaNormalizer', () => {
  it('normalizes a task from the { results: [...] } path and emits a Task', () => {
    const n = new AsanaNormalizer();
    const recs = n.normalize({
      results: [
        {
          gid: '1001',
          name: 'Ship polling',
          completed: true,
          due_on: '2026-07-01',
          modified_at: '2026-06-26T10:00:00.000Z',
          assignee: { gid: 'u9', name: 'Dana' },
          projects: [{ gid: 'p1', name: 'Connectors' }],
        },
      ],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Task');
    expect(recs[0].externalId).toBe('1001');
    expect(recs[0].data.name).toBe('Ship polling');
    expect(recs[0].data.completed).toBe(true);
    expect(recs[0].data.dueOn).toBe('2026-07-01');
    expect((recs[0].data.assignee as { name: string }).name).toBe('Dana');
    expect(recs[0].metadata.source).toBe('asana');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00.000Z');
  });

  it('skips records without a gid and declares the Task schema with the modifiedAt anchor', () => {
    const n = new AsanaNormalizer();
    expect(n.normalize({ results: [{ name: 'no gid' }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Task)).toMatch(/modifiedAt/);
  });
});
