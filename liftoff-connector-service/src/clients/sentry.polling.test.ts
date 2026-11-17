// SentryClient.list('Issue') (REST Issues API, org-resolve + Link cursor) + normalizer.

import { SentryClient } from './sentry.js';
import { SentryNormalizer } from '../normalizers/sentry.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'sntryu_test', instanceUrl: undefined, tenantId: 't1', connectorId: 'c1',
});

function mockResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SentryClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the org then queries issues with lastSeen + sort=date, surfacing the Link cursor', async () => {
    const spy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse([{ slug: 'os-inc' }]))        // /organizations/
      .mockResolvedValueOnce(mockResponse(                                       // /issues/
        [{ id: '42', shortId: 'PROJ-1', title: 'TypeError', level: 'error', status: 'unresolved', lastSeen: '2026-06-26T10:00:00Z' }],
        { link: '<https://sentry.io/...?cursor=c1>; rel="next"; results="true"; cursor="c1"' },
      ));
    const client = new SentryClient(credentialProvider);
    const res = await client.list('Issue', { since: new Date('2026-06-25T00:00:00Z'), limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('42');
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('c1');

    const orgUrl = spy.mock.calls[0][0] as string;
    const issuesUrl = spy.mock.calls[1][0] as string;
    expect(orgUrl).toContain('/organizations/');
    expect(issuesUrl).toContain('/organizations/os-inc/issues/');
    expect(issuesUrl).toContain('sort=date');
    expect(decodeURIComponent(issuesUrl)).toContain('lastSeen:>=2026-06-25T00:00:00.000Z');
  });

  it('returns no cursor when the Link header has no next page', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse([{ slug: 'org1' }]))
      .mockResolvedValueOnce(mockResponse([{ id: '7' }], { link: '<...>; rel="previous"; results="false"; cursor="p"' }));
    const res = await new SentryClient(credentialProvider).list('Issue', {});
    expect(res.hasMore).toBe(false);
    expect(res.nextPageToken).toBeUndefined();
  });

  it('returns empty for a non-Issue entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    expect((await new SentryClient(credentialProvider).list('Event')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('SentryNormalizer', () => {
  it('normalizes an issue from { results: [...] } with lastSeen as version', () => {
    const recs = new SentryNormalizer().normalize({
      results: [{
        id: 42, shortId: 'PROJ-1', title: 'TypeError: x', culprit: 'app.run', level: 'error',
        status: 'unresolved', count: '17', userCount: 3, firstSeen: '2026-06-20T00:00:00Z',
        lastSeen: '2026-06-26T10:00:00Z', project: { slug: 'backend' },
        metadata: { type: 'TypeError', value: 'x is undefined' },
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Issue');
    expect(recs[0].externalId).toBe('42');
    expect(recs[0].data.eventCount).toBe(17);
    expect(recs[0].data.projectSlug).toBe('backend');
    expect(recs[0].data.errorType).toBe('TypeError');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00Z');
  });
});
