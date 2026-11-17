// Hermetic tests for the Google YouTube connector client — Analytics + Reporting surfaces.
//
// Data API methods are smoke-covered by the broader catalog tests; this file
// focuses on the three-base-URL fan-out so we don't accidentally aim Analytics
// or Reporting calls at the Data API host (which would just return 404 with no
// clear breadcrumb to the cause).

import { GoogleYouTubeClient } from './google-youtube.js';
import type { CredentialProvider } from './types.js';

function mockResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('GoogleYouTubeClient — Analytics + Reporting', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'ya29.test',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({}));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('Analytics API — analytics_report', () => {
    it('hits youtubeanalytics.googleapis.com/v2/reports with required params', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ rows: [[100, 10]] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.read('analytics_report', undefined, {
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        metrics: 'views,likes',
      });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('https://youtubeanalytics.googleapis.com/v2/reports?');
      expect(url).toContain('ids=channel%3D%3DMINE');
      expect(url).toContain('startDate=2026-05-01');
      expect(url).toContain('endDate=2026-05-31');
      expect(url).toContain('metrics=views%2Clikes');
      expect(result.id).toBe('analytics_report');
      expect((result.data as { rows: unknown[] }).rows).toEqual([[100, 10]]);
    });

    it('forwards optional dimensions, filters, sort, ids, maxResults', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ rows: [] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      await client.read('analytics_report', undefined, {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        metrics: 'views',
        dimensions: 'day',
        filters: 'country==US',
        sort: '-views',
        ids: 'channel==UC123',
        maxResults: 25,
      });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('dimensions=day');
      expect(url).toContain('filters=country%3D%3DUS');
      expect(url).toContain('sort=-views');
      expect(url).toContain('ids=channel%3D%3DUC123');
      expect(url).toContain('maxResults=25');
    });

    it('rejects when required fields are missing', async () => {
      const client = new GoogleYouTubeClient(credentialProvider);
      await expect(
        client.read('analytics_report', undefined, { endDate: '2026-05-31', metrics: 'views' }),
      ).rejects.toThrow(/startDate/);
      await expect(
        client.read('analytics_report', undefined, { startDate: '2026-05-01', metrics: 'views' }),
      ).rejects.toThrow(/endDate/);
      await expect(
        client.read('analytics_report', undefined, { startDate: '2026-05-01', endDate: '2026-05-31' }),
      ).rejects.toThrow(/metrics/);
    });
  });

  describe('Reporting API — report types + jobs', () => {
    it('list report_types hits youtubereporting.googleapis.com/v1/reportTypes', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ reportTypes: [{ id: 'channel_basic_a2' }] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.read('report_types', undefined, { includeSystemManaged: true });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('https://youtubereporting.googleapis.com/v1/reportTypes?');
      expect(url).toContain('includeSystemManaged=true');
      expect(result.id).toBe('report_types');
    });

    it('list reporting_jobs hits /v1/jobs on the reporting host', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ jobs: [] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      await client.read('reporting_jobs', undefined, {});

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('https://youtubereporting.googleapis.com/v1/jobs?');
    });

    it('list reports requires jobId and embeds it in the path', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ reports: [] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      await client.read('reports', undefined, { jobId: 'job-xyz', pageSize: 10 });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('https://youtubereporting.googleapis.com/v1/jobs/job-xyz/reports?');
      expect(url).toContain('pageSize=10');

      const client2 = new GoogleYouTubeClient(credentialProvider);
      await expect(client2.read('reports', undefined, {})).rejects.toThrow(/jobId/);
    });

    it('create reporting_job POSTs to /v1/jobs with reportTypeId', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'job-new', reportTypeId: 'channel_basic_a2' }));
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.create('reporting_job', {
        reportTypeId: 'channel_basic_a2',
        name: 'Daily channel basics',
      });

      const url = fetchSpy.mock.calls[0][0] as string;
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(url).toBe('https://youtubereporting.googleapis.com/v1/jobs');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        reportTypeId: 'channel_basic_a2',
        name: 'Daily channel basics',
      });
      expect(result.success).toBe(true);
      expect(result.id).toBe('job-new');
    });

    it('create reporting_job fails fast without reportTypeId', async () => {
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.create('reporting_job', {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/reportTypeId/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('delete reporting_job DELETEs /v1/jobs/{id}', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 204));
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.delete('reporting_job', 'job-xyz');

      const url = fetchSpy.mock.calls[0][0] as string;
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(url).toBe('https://youtubereporting.googleapis.com/v1/jobs/job-xyz');
      expect(init.method).toBe('DELETE');
      expect(result.success).toBe(true);
    });

    it('semantic inverse of create reporting_job calls delete', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 204));
      const client = new GoogleYouTubeClient(credentialProvider);
      const result = await client.semanticInverse('reporting_job', 'create', 'job-xyz', {});

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe('https://youtubereporting.googleapis.com/v1/jobs/job-xyz');
      expect(result.success).toBe(true);
    });
  });

  describe('Data API calls still hit /youtube/v3', () => {
    it('read channel routes to googleapis.com/youtube/v3 not analytics or reporting', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ items: [{ id: 'UC1', snippet: {} }] }));
      const client = new GoogleYouTubeClient(credentialProvider);
      await client.read('channel', undefined, {});
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('https://www.googleapis.com/youtube/v3/channels?');
      expect(url).not.toContain('youtubeanalytics');
      expect(url).not.toContain('youtubereporting');
    });
  });
});
