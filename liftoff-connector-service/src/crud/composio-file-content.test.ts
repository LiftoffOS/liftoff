// Tests for GET /:connectorId/files/:fileId/content across the two credential
// transports.
//
// The bug these pin: the route required a direct OAuth access token, and a
// composio_managed connector never has one — Composio holds the grant and
// returns "REDACTED" for the token. So the route answered 401 "No access token
// for connector" for every Composio-managed Drive file, while /browse listed
// those same files happily through the proxy, and knowledge extraction failed
// with `connector-service binary fetch failed: 401` on every file.
//
// The second half is the export format. A Google-native file has no bytes;
// Drive materialises it into whatever you ask for. Asking for .xlsx produced a
// spreadsheet nothing downstream could parse — not the knowledge extractor
// (mammoth/pdf-parse only), not the runtime's readDocument. `?exportAs=text`
// is how a caller that is going to parse to a string says so, while
// editDocument keeps getting real .docx bytes to rewrite.

jest.mock('../clients/composio-transport.js', () => ({ tryComposioProxy: jest.fn() }));
jest.mock('../credentials/google-fetcher.js', () => ({
  makeGoogleFetcher: jest.fn(),
  makeGoogleApiFetcher: jest.fn(),
}));

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

import { connectorCrudRouter } from './router.js';
import { connectorCrudService } from './service.js';
import { credentialService } from '../credentials/service.js';
import { tryComposioProxy } from '../clients/composio-transport.js';
import { makeGoogleFetcher, makeGoogleApiFetcher } from '../credentials/google-fetcher.js';

const mockProxy = tryComposioProxy as unknown as jest.Mock;
const mockGoogleFetcher = makeGoogleFetcher as unknown as jest.Mock;
const mockGoogleApiFetcher = makeGoogleApiFetcher as unknown as jest.Mock;

/** Reply to the two Sheets API calls a spreadsheet read makes: list the tabs,
 *  then batch-get their values. */
function sheetsApiReturning(titles: string[], valuesPerSheet: unknown[][][]) {
  const responses = [
    { sheets: titles.map((title) => ({ properties: { title } })) },
    { valueRanges: valuesPerSheet.map((values) => ({ values })) },
  ];
  let call = 0;
  mockGoogleApiFetcher.mockReturnValue((() =>
    Promise.resolve(
      new Response(JSON.stringify(responses[call++] ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as never);
}

function startServer(): Promise<{ server: http.Server; url: string }> {
  const app = express();
  app.use('/api/connectors', express.json(), connectorCrudRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

const driveConnector = {
  id: 'd-1',
  tenantId: 't1',
  type: 'google_drive' as const,
  name: 'Google Drive',
  status: 'active' as const,
  config: {},
  apiKeyHint: null,
  lastSyncAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const composioCreds = {
  flowKind: 'composio_managed',
  accessToken: '',
  connectorConfig: { composioConnectedAccountId: 'ca_test' },
};

const directCreds = { flowKind: 'oauth2', accessToken: 'ya29.token' };

/** Reply to the Drive metadata call, then to whatever download follows. */
function proxyReturns(meta: { name: string; mimeType: string }, body: unknown) {
  mockProxy
    .mockResolvedValueOnce({ handled: true, data: meta } as never)
    .mockResolvedValueOnce({ handled: true, data: body } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(driveConnector as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('file content — composio_managed connectors', () => {
  it('serves a Google Doc as text instead of 401ing for a token Composio never issues', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    proxyReturns(
      { name: 'Q3 report', mimeType: 'application/vnd.google-apps.document' },
      'the extracted body text',
    );

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/d-1/files/file-1/content?tenantId=t1&exportAs=text',
      );

      expect(res.status).toBe(200);
      expect(res.text).toBe('the extracted body text');
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.headers['content-disposition']).toContain('Q3 report.txt');

      // Second proxy call is the export, and it asks for text.
      const exportCall = mockProxy.mock.calls[1][1] as { path: string; query: Record<string, string> };
      expect(exportCall.path).toContain('/files/file-1/export');
      expect(exportCall.query.mimeType).toBe('text/plain');
    } finally { server.close(); }
  });

  it('serves a Google Sheet as CSV, reading every worksheet rather than the first', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockProxy.mockResolvedValueOnce({
      handled: true,
      data: { name: 'Pipeline', mimeType: 'application/vnd.google-apps.spreadsheet' },
    } as never);
    // Two tabs. Drive's CSV export would have returned only the first, silently.
    sheetsApiReturning(
      ['Summary', 'Deals'],
      [
        [['stage', 'count'], ['qualified', 12]],
        [['deal', 'value'], ['acme', 90000]],
      ],
    );

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/d-1/files/file-2/content?tenantId=t1&exportAs=text',
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toContain('Pipeline.csv');
      // Both tabs, each labelled so two grids do not read as one broken table.
      expect(res.text).toContain('--- Sheet: Summary ---');
      expect(res.text).toContain('qualified,12');
      expect(res.text).toContain('--- Sheet: Deals ---');
      expect(res.text).toContain('acme,90000');
    } finally { server.close(); }
  });

  it('refuses a binary export with a reason instead of a corrupted body', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockProxy.mockResolvedValueOnce({
      handled: true,
      data: { name: 'Q3 report', mimeType: 'application/vnd.google-apps.document' },
    } as never);

    const { server, url } = await startServer();
    try {
      // No exportAs → the caller wants .docx bytes, which cannot cross the proxy.
      const res = await request(url).get('/api/connectors/d-1/files/file-1/content?tenantId=t1');

      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/exportAs=text/);
      // It stopped at metadata; it did not fetch and mangle a body.
      expect(mockProxy).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it('refuses an uploaded PDF, naming why, rather than shipping decoded bytes', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockProxy.mockResolvedValueOnce({
      handled: true,
      data: { name: 'contract.pdf', mimeType: 'application/pdf' },
    } as never);

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/d-1/files/file-3/content?tenantId=t1&exportAs=text',
      );

      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/corrupted|binary/i);
      expect(res.body.sourceMimeType).toBe('application/pdf');
      expect(mockProxy).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it('passes an uploaded text file straight through', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    proxyReturns({ name: 'notes.md', mimeType: 'text/markdown' }, '# Notes\nbody');

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/d-1/files/file-4/content?tenantId=t1&exportAs=text',
      );

      expect(res.status).toBe(200);
      expect(res.text).toContain('# Notes');
      // alt=media, not an export — the file has real bytes of its own.
      expect((mockProxy.mock.calls[1][1] as { query: Record<string, string> }).query.alt).toBe('media');
    } finally { server.close(); }
  });

  it('surfaces a metadata failure as 502 rather than a silent empty file', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockProxy.mockResolvedValueOnce({ handled: true, data: {} } as never);

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/d-1/files/file-5/content?tenantId=t1&exportAs=text',
      );
      expect(res.status).toBe(502);
    } finally { server.close(); }
  });
});

describe('file content — direct-token connectors', () => {
  it('honours exportAs=text so both transports answer the same question the same way', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(directCreds as never);
    const fetches: string[] = [];
    mockGoogleFetcher.mockReturnValue(((urlArg: string) => {
      fetches.push(urlArg);
      if (fetches.length === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ name: 'Q3 report', mimeType: 'application/vnd.google-apps.document' }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Map(),
        body: null,
      });
    }) as never);

    const { server, url } = await startServer();
    try {
      await request(url).get('/api/connectors/d-1/files/file-1/content?tenantId=t1&exportAs=text');
      expect(fetches[1]).toContain(encodeURIComponent('text/plain'));
    } finally { server.close(); }
  });

  it('still exports .docx when the caller says nothing, because editDocument rewrites real bytes', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(directCreds as never);
    const fetches: string[] = [];
    mockGoogleFetcher.mockReturnValue(((urlArg: string) => {
      fetches.push(urlArg);
      if (fetches.length === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ name: 'Q3 report', mimeType: 'application/vnd.google-apps.document' }),
        });
      }
      return Promise.resolve({ ok: true, headers: new Map(), body: null });
    }) as never);

    const { server, url } = await startServer();
    try {
      await request(url).get('/api/connectors/d-1/files/file-1/content?tenantId=t1');
      expect(fetches[1]).toContain(encodeURIComponent('wordprocessingml.document'));
    } finally { server.close(); }
  });
});
