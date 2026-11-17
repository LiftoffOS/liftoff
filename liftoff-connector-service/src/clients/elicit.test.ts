import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { ElicitClient } from './elicit.js';
import type { CredentialProvider } from './types.js';

const creds: CredentialProvider = async () => ({
  accessToken: '',
  connectorConfig: { apiKey: 'elk_live_test123' },
});

function mockFetch(body: unknown, status = 200): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response);
}

/** Return the [url, init] the client called fetch with. */
function callArgs(spy: jest.SpiedFunction<typeof fetch>): [string, RequestInit] {
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
  return [String(url), init];
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ElicitClient', () => {
  it('search_papers POSTs to /api/v1/search with a Bearer key and the query body', async () => {
    const spy = mockFetch({ results: [{ title: 'A paper' }] });
    const client = new ElicitClient(creds);
    const rec = await client.read('papers', undefined, {
      query: 'intermittent fasting', maxResults: 5, filters: { minYear: 2020 },
    });
    const [url, init] = callArgs(spy);
    expect(url).toBe('https://elicit.com/api/v1/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer elk_live_test123');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'intermittent fasting', maxResults: 5, filters: { minYear: 2020 } });
    expect(rec.data).toEqual({ results: [{ title: 'A paper' }] });
  });

  it('search_clinical_trials POSTs to /api/v1/search/trials', async () => {
    const spy = mockFetch({ results: [] });
    await new ElicitClient(creds).read('trials', undefined, { query: 'SGLT2 heart failure' });
    expect(callArgs(spy)[0]).toBe('https://elicit.com/api/v1/search/trials');
  });

  it('create_report POSTs to /api/v1/reports and returns the reportId', async () => {
    const spy = mockFetch({ reportId: 'r-123', status: 'processing', url: 'https://elicit.com/reports/r-123' }, 201);
    const res = await new ElicitClient(creds).create('report', {
      researchQuestion: 'Do GLP-1 agonists improve CV outcomes?', maxSearchPapers: 100,
    });
    const [url, init] = callArgs(spy);
    expect(url).toBe('https://elicit.com/api/v1/reports');
    expect(init.method).toBe('POST');
    expect(res.success).toBe(true);
    expect(res.id).toBe('r-123');
  });

  it('get_report GETs /api/v1/reports/{reportId} using reportId from the payload', async () => {
    const spy = mockFetch({ reportId: 'r-123', status: 'completed', result: { title: 'T', summary: 'S' } });
    const rec = await new ElicitClient(creds).read('report', undefined, { reportId: 'r-123', include: 'reportBody' });
    const [url, init] = callArgs(spy);
    expect(url).toBe('https://elicit.com/api/v1/reports/r-123?include=reportBody');
    expect(init.method).toBe('GET');
    expect(rec.id).toBe('r-123');
  });

  it('list_reports GETs /api/v1/reports with query filters', async () => {
    const spy = mockFetch({ reports: [], nextCursor: null });
    await new ElicitClient(creds).read('reports', undefined, { limit: 10, status: 'completed' });
    expect(callArgs(spy)[0]).toBe('https://elicit.com/api/v1/reports?limit=10&status=completed');
  });

  it('create_systematic_review POSTs to /api/v1/systematic-reviews and returns the reviewId', async () => {
    const spy = mockFetch({ reviewId: 'sr-9', status: 'processing' });
    const res = await new ElicitClient(creds).create('systematic_review', { researchQuestion: 'Q', generateReport: true });
    expect(callArgs(spy)[0]).toBe('https://elicit.com/api/v1/systematic-reviews');
    expect(res.id).toBe('sr-9');
  });

  it('get_systematic_review GETs /api/v1/systematic-reviews/{reviewId}', async () => {
    const spy = mockFetch({ reviewId: 'sr-9', status: 'completed' });
    await new ElicitClient(creds).read('systematic_review', undefined, { reviewId: 'sr-9' });
    expect(callArgs(spy)[0]).toBe('https://elicit.com/api/v1/systematic-reviews/sr-9');
  });

  it('throws when the API key is missing', async () => {
    const noKey: CredentialProvider = async () => ({ accessToken: '', connectorConfig: {} });
    await expect(new ElicitClient(noKey).read('reports', undefined, {})).rejects.toThrow(/missing API key/);
  });

  it('surfaces API errors with status and body', async () => {
    mockFetch({ error: 'unauthorized' }, 401);
    await expect(new ElicitClient(creds).read('reports', undefined, {})).rejects.toThrow(/Elicit API 401/);
  });

  it('create returns a failure result for an unsupported entityType', async () => {
    const res = await new ElicitClient(creds).create('nonsense', {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported create entityType/);
  });
});
