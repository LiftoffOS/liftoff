// Tests for the native Google Docs edit path.
//
// The runtime's editDocument downloads a .docx, applies tracked changes and
// returns a redlined file. A composio_managed connector has no bytes to give —
// Composio signs requests server-side and never releases the token — so that
// path cannot run at all for those tenants. This copies the document and
// applies the edits to the copy, the same shape presentations/copy-and-replace
// already uses.
//
// The fidelity gaps are real and must stay visible: no tracked changes (the
// Docs API cannot create suggestions) and replaceAllText hits every
// occurrence, so the caller gets counts back rather than a bare success.

jest.mock('../../credentials/service.js', () => ({
  credentialService: { getCredentials: jest.fn() },
}));
jest.mock('../../credentials/google-fetcher.js', () => ({
  makeGoogleApiFetcher: jest.fn(),
}));

import { jest } from '@jest/globals';
import { handleCopyAndEditDocument } from './documents.js';
import { makeGoogleApiFetcher } from '../../credentials/google-fetcher.js';
import { credentialService } from '../../credentials/service.js';

const mockFetcher = makeGoogleApiFetcher as unknown as jest.Mock;

function googleReturning(responses: Array<{ status?: number; body: unknown }>) {
  let call = 0;
  mockFetcher.mockReturnValue((() => {
    const r = responses[call++] ?? { body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  (credentialService.getCredentials as unknown as jest.Mock).mockResolvedValue({
    flowKind: 'composio_managed',
    accessToken: '',
  } as never);
});

describe('handleCopyAndEditDocument', () => {
  it('copies the document and edits the copy, leaving the original alone', async () => {
    googleReturning([
      { body: { id: 'copy-1', name: 'Contract v2' } },
      { body: { replies: [{ replaceAllText: { occurrencesChanged: 3 } }] } },
    ]);

    const result = await handleCopyAndEditDocument({
      connectorId: 'c1',
      tenantId: 't1',
      documentId: 'source-doc',
      body: { name: 'Contract v2', edits: [{ find: 'Acme', replace: 'Acme Corp' }] },
    });

    expect(result.documentId).toBe('copy-1');
    expect(result.webViewUrl).toBe('https://docs.google.com/document/d/copy-1/edit');
    expect(result.replacements).toEqual([{ find: 'Acme', occurrencesChanged: 3 }]);
    expect(result.unmatched).toEqual([]);
  });

  it('reports an edit that matched nothing instead of passing it off as applied', async () => {
    googleReturning([
      { body: { id: 'copy-2', name: 'Copy' } },
      {
        body: {
          replies: [
            { replaceAllText: { occurrencesChanged: 1 } },
            { replaceAllText: { occurrencesChanged: 0 } },
          ],
        },
      },
    ]);

    const result = await handleCopyAndEditDocument({
      connectorId: 'c1',
      tenantId: 't1',
      documentId: 'source-doc',
      body: {
        edits: [
          { find: 'here', replace: 'there' },
          { find: 'absent phrase', replace: 'x' },
        ],
      },
    });

    // The job succeeded; one of the edits did not. Both facts survive.
    expect(result.replacements[1].occurrencesChanged).toBe(0);
    expect(result.unmatched).toEqual(['absent phrase']);
  });

  it('fails loudly when the copy fails, rather than editing the original', async () => {
    googleReturning([{ status: 403, body: { error: 'insufficient permission' } }]);

    await expect(
      handleCopyAndEditDocument({
        connectorId: 'c1',
        tenantId: 't1',
        documentId: 'source-doc',
        body: { edits: [{ find: 'a', replace: 'b' }] },
      }),
    ).rejects.toThrow(/Copy failed: 403/);
  });

  it('fails when the edits fail, so a bare copy is not reported as edited', async () => {
    googleReturning([
      { body: { id: 'copy-3', name: 'Copy' } },
      { status: 400, body: { error: 'bad request' } },
    ]);

    await expect(
      handleCopyAndEditDocument({
        connectorId: 'c1',
        tenantId: 't1',
        documentId: 'source-doc',
        body: { edits: [{ find: 'a', replace: 'b' }] },
      }),
    ).rejects.toThrow(/Edits failed after copy: 400/);
  });
});
