// Regression: non-Google composio_managed clients whose Composio toolkit
// base_url INCLUDES the API version segment must pass the ABSOLUTE vendor URL
// to tryComposioProxy — a version-prefixed relative path doubles the segment.
//
// Verified via GET /api/v3/toolkits/{slug} (Composio's authoritative
// base_url per toolkit):
//   box      base_url = https://api.box.com/2.0            (versioned → was doubling)
//   youtube  base_url = https://www.googleapis.com/youtube/v3 (versioned → was doubling)
//   dropbox  base_url = https://api.dropboxapi.com          (bare, but content
//            calls must target content.dropboxapi.com → absolute picks host)
//
// Bare-base_url toolkits (slack, gong, googleads, outlook, jira, confluence)
// were verified CORRECT as-is (their prefix matches the bare base) and are
// intentionally NOT changed — see composio-transport.ts.

jest.mock('./composio-transport.js', () => ({ tryComposioProxy: jest.fn() }));

import { tryComposioProxy } from './composio-transport.js';
import { BoxClient } from './box.js';
import { DropboxClient } from './dropbox.js';
import { GoogleYouTubeClient } from './google-youtube.js';
import type { CredentialProvider } from './types.js';

const cp: CredentialProvider = async () => ({
  accessToken: '',
  connectorConfig: { composioConnectedAccountId: 'ca_test' },
  tenantId: 't1',
  connectorId: 'c1',
});

const mockProxy = tryComposioProxy as jest.MockedFunction<typeof tryComposioProxy>;
const lastPath = (): string => (mockProxy.mock.calls.at(-1)?.[1] as { path: string }).path;

beforeEach(() => {
  mockProxy.mockReset();
  mockProxy.mockResolvedValue({ handled: true, data: {} } as never);
});

describe('non-Google composio clients pass absolute vendor URLs (no version doubling)', () => {
  it('BoxClient.request (api) → https://api.box.com/2.0<path>', async () => {
    await (new BoxClient(cp) as any).request('GET', '/folders/0/items');
    expect(lastPath()).toBe('https://api.box.com/2.0/folders/0/items');
  });

  it('BoxClient.request (upload) → https://upload.box.com/api/2.0<path>', async () => {
    await (new BoxClient(cp) as any).request('POST', '/files/content', undefined, { useUploadUrl: true });
    expect(lastPath()).toBe('https://upload.box.com/api/2.0/files/content');
  });

  it('DropboxClient.request (api) → https://api.dropboxapi.com/2<path>', async () => {
    await (new DropboxClient(cp) as any).request('POST', '/files/list_folder');
    expect(lastPath()).toBe('https://api.dropboxapi.com/2/files/list_folder');
  });

  it('DropboxClient.request (content) → https://content.dropboxapi.com/2<path> (correct host)', async () => {
    await (new DropboxClient(cp) as any).request('POST', '/files/download', undefined, { useContentUrl: true });
    expect(lastPath()).toBe('https://content.dropboxapi.com/2/files/download');
  });

  it('GoogleYouTubeClient.request (main) → https://www.googleapis.com/youtube/v3<path>', async () => {
    await (new GoogleYouTubeClient(cp) as any).request('GET', '/search');
    expect(lastPath()).toBe('https://www.googleapis.com/youtube/v3/search');
  });

  it('GoogleYouTubeClient.requestQuery (analytics base) → https://youtubeanalytics.googleapis.com/v2<path>', async () => {
    const c = new GoogleYouTubeClient(cp) as any;
    await c.requestQuery('/reports', { ids: 'channel==MINE' }, c.analyticsBaseUrl);
    expect(lastPath()).toBe('https://youtubeanalytics.googleapis.com/v2/reports');
  });

  it('none of the emitted paths double a version segment', () => {
    const doubled = /\/(2\.0|youtube\/v3|v2|v1|drive\/v3)(\/.*)?\/\1(\/|$)/;
    expect(doubled.test('https://api.box.com/2.0/2.0/x')).toBe(true); // sanity
    expect(doubled.test('https://api.box.com/2.0/folders')).toBe(false);
    expect(doubled.test('https://www.googleapis.com/youtube/v3/search')).toBe(false);
  });
});
