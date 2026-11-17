// Hermetic tests for Microsoft To Do reactive polling (entity type Task).
//
// To Do tasks live under lists, so list('Task') fans out:
//   GET /me/todo/lists  ->  for each list, GET /me/todo/lists/{listId}/tasks
// Each task is stamped with its owning listId so the normalizer can build the
// composite listId:taskId externalId. This file asserts both the client's
// fan-out + $filter and the normalizer's { results: [...] } polling branch.

import { MicrosoftToDoClient } from './microsoft-todo.js';
import { MicrosoftToDoNormalizer } from '../normalizers/microsoft-todo.normalizer.js';
import type { CredentialProvider } from './types.js';

function mockResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('MicrosoftToDoClient.list — Task polling fan-out', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'graph.test',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists tasks per list and applies the lastModifiedDateTime $filter', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [{ id: 'L1' }] }))
      .mockResolvedValueOnce(
        mockResponse({
          value: [
            { id: 'T1', title: 'x', lastModifiedDateTime: '2026-06-20T00:00:00Z' },
          ],
        }),
      );

    const client = new MicrosoftToDoClient(credentialProvider);
    const since = new Date('2026-06-01T00:00:00.000Z');
    const result = await client.list('Task', { since, limit: 100 });

    // First call enumerates lists.
    expect(fetchSpy.mock.calls[0][0] as string).toBe(
      'https://graph.microsoft.com/v1.0/me/todo/lists',
    );

    // Second call pulls tasks for list L1, carrying $filter + $orderby + $top.
    const tasksUrl = fetchSpy.mock.calls[1][0] as string;
    expect(tasksUrl).toContain('/me/todo/lists/L1/tasks');
    expect(tasksUrl).toContain(
      '%24filter=lastModifiedDateTime+ge+2026-06-01T00%3A00%3A00.000Z',
    );
    expect(tasksUrl).toContain('%24orderby=lastModifiedDateTime');
    expect(tasksUrl).toContain('%24top=100');

    // Fan-out aggregates all lists in one cycle: no cross-list cursor.
    expect(result.hasMore).toBe(false);
    expect(result.nextPageToken).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe('T1');
    // listId stamped into data for the normalizer.
    expect(result.records[0].data.listId).toBe('L1');
  });

  it('returns empty for non-Task entity types without calling Graph', async () => {
    const client = new MicrosoftToDoClient(credentialProvider);
    const result = await client.list('TaskList', {});
    expect(result).toEqual({ records: [], hasMore: false, unsupported: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('MicrosoftToDoNormalizer — { results: [...] } polling branch', () => {
  it('emits an entityType:Task record from wrapped polling rows', () => {
    const normalizer = new MicrosoftToDoNormalizer();
    const records = normalizer.normalize({
      results: [
        {
          id: 'T1',
          title: 'x',
          status: 'notStarted',
          listId: 'L1',
          lastModifiedDateTime: '2026-06-20T00:00:00Z',
        },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0].entityType).toBe('Task');
    // Composite externalId built from listId:taskId.
    expect(records[0].externalId).toBe('L1:T1');
    expect(records[0].data.id).toBe('L1:T1');
    // Version anchors on lastModifiedDateTime for delta dedup.
    expect(records[0].metadata.version).toBe('2026-06-20T00:00:00Z');
  });
});
