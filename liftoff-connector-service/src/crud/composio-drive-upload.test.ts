// A .docx or .pptx a team writes for a Composio-managed Google Drive uploads.
//
// The upload route carried a Composio carve-out for Microsoft only, above a
// token guard whose own comment named "every generate_docx / generate_pptx".
// A Composio-managed Drive has no raw access token, reached the guard, and
// answered 401 "No access token for connector" —
// surfaced to the person as "Couldn't save to your cloud storage. Re-authorize"
// over a connection that was fine. The download route beside it had branched on
// flowKind for every type since it was fixed; this pins the upload route to the
// same rule.

jest.mock('../clients/composio-transport.js', () => ({ tryComposioProxy: jest.fn() }));
jest.mock('../oauth/composio-client.js', () => ({
  composioProxyBinaryUpload: jest.fn(),
  deleteComposioConnectedAccount: jest.fn(),
}));
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
import { composioProxyBinaryUpload } from '../oauth/composio-client.js';
import { makeGoogleFetcher } from '../credentials/google-fetcher.js';

const mockProxy = tryComposioProxy as unknown as jest.Mock;
const mockBinaryUpload = composioProxyBinaryUpload as unknown as jest.Mock;
const mockGoogleFetcher = makeGoogleFetcher as unknown as jest.Mock;

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

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function upload(url: string, opts: { destinationPath?: string } = {}) {
  let req = request(url)
    .post('/api/connectors/d-1/files')
    .field('tenantId', 't1')
    .field('filename', 'Deck.pptx')
    .field('mimeType', PPTX);
  if (opts.destinationPath) req = req.field('destinationPath', opts.destinationPath);
  return req.attach('file', Buffer.from('PK not really a pptx'), { filename: 'Deck.pptx', contentType: PPTX });
}

describe('POST /:connectorId/files — a Composio-managed Google Drive', () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => ({ server, url } = await startServer()));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(driveConnector as never);
    mockProxy.mockReset();
    mockBinaryUpload.mockReset();
    mockGoogleFetcher.mockReset();
  });

  it('uploads through the Composio proxy and never reads an access token', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockBinaryUpload.mockResolvedValue({ status: 200, data: { id: 'file-9' } } as never);
    mockProxy.mockResolvedValue({
      handled: true,
      data: { id: 'file-9', name: 'Deck.pptx', webViewLink: 'https://drive.google.com/file/d/file-9/view' },
    } as never);

    const res = await upload(url, { destinationPath: 'folder-7' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ fileId: 'file-9', path: 'folder-7', webViewUrl: 'https://drive.google.com/file/d/file-9/view' });
    // The bytes rode the binary proxy as a raw media upload …
    expect(mockBinaryUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAccountId: 'ca_test',
        method: 'POST',
        endpoint: expect.stringContaining('upload/drive/v3/files?uploadType=media'),
        contentType: PPTX,
      }),
    );
    // … then one metadata PATCH named the file and placed it in the folder.
    expect(mockProxy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'PATCH',
        path: expect.stringContaining('/drive/v3/files/file-9'),
        query: expect.objectContaining({ addParents: 'folder-7' }),
        body: { name: 'Deck.pptx' },
      }),
    );
    // The token path was never consulted: that is the guard this test exists to hold.
    expect(mockGoogleFetcher).not.toHaveBeenCalled();
  });

  it('falls back to the file view URL when the metadata PATCH is not handled', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockBinaryUpload.mockResolvedValue({ status: 200, data: { id: 'file-9' } } as never);
    mockProxy.mockResolvedValue({ handled: false } as never);

    const res = await upload(url);

    expect(res.status).toBe(201);
    expect(res.body.webViewUrl).toBe('https://drive.google.com/file/d/file-9/view');
  });

  it('answers 502, not 201, when Drive returns no file id', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(composioCreds as never);
    mockBinaryUpload.mockResolvedValue({ status: 200, data: {} } as never);

    const res = await upload(url);

    expect(res.status).toBe(502);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('still uploads a directly-authorised Drive through the token path', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue(directCreds as never);
    mockGoogleFetcher.mockReturnValue((() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'file-3', name: 'Deck.pptx', webViewLink: 'https://drive.google.com/file/d/file-3/view' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as never);

    const res = await upload(url);

    expect(res.status).toBe(201);
    expect(res.body.fileId).toBe('file-3');
    expect(mockBinaryUpload).not.toHaveBeenCalled();
  });
});
