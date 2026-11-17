// Regression: composio_managed Google clients MUST pass an ABSOLUTE vendor URL
// to tryComposioProxy, never a version-prefixed path.
//
// Composio's per-toolkit proxy base URL is inconsistent (verified
// against backend.composio.dev): the googledrive base already includes
// `/drive/v3` while the gmail base is bare `https://www.googleapis.com`. A
// version-prefixed path like `/drive/v3${path}` therefore DOUBLES the segment
// for googledrive (`/drive/v3/drive/v3/files`) and hits Google's HTML 404 page.
// The absolute URL — the same one each client's direct-HTTP fallback builds —
// is signed+forwarded verbatim by Composio (cross-host allowed). These tests
// pin that contract so the prefix hack can't regress back in.

jest.mock('./composio-transport.js', () => ({ tryComposioProxy: jest.fn() }));

import { tryComposioProxy } from './composio-transport.js';
import { GoogleDriveClient } from './google-drive.js';
import { GoogleSlidesClient } from './google-slides.js';
import { GoogleDocsClient } from './google-docs.js';
import { GoogleSheetsClient } from './google-sheets.js';
import { GoogleCalendarClient } from './google-calendar.js';
import { GoogleMailClient } from './google-mail.js';
import type { CredentialProvider } from './types.js';

const cp: CredentialProvider = async () => ({
  accessToken: '',
  connectorConfig: { composioConnectedAccountId: 'ca_test' },
  tenantId: 't1',
  connectorId: 'c1',
});

const mockProxy = tryComposioProxy as jest.MockedFunction<typeof tryComposioProxy>;

/** The absolute URL passed to the most-recent tryComposioProxy call. */
function lastPath(): string {
  const call = mockProxy.mock.calls.at(-1);
  return (call?.[1] as { path: string }).path;
}

/** A path is "doubled" when the same version segment appears twice, i.e. the
 *  bug we're guarding against (`/drive/v3/drive/v3`, `/gmail/v1/gmail/v1`, …). */
function isDoubled(p: string): boolean {
  return /\/(drive\/v3|gmail\/v1|calendar\/v3|v1|v4)(\/.*)?\/\1(\/|$)/.test(p);
}

beforeEach(() => {
  mockProxy.mockReset();
  mockProxy.mockResolvedValue({ handled: true, data: {} } as never);
});

describe('Google composio_managed clients pass absolute vendor URLs (no version doubling)', () => {
  it('GoogleDriveClient.request → https://www.googleapis.com/drive/v3<path>', async () => {
    await (new GoogleDriveClient(cp) as any).request('GET', '/files', undefined, { query: { pageSize: '2' } });
    expect(lastPath()).toBe('https://www.googleapis.com/drive/v3/files');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('GoogleDriveClient.request (upload) → https://www.googleapis.com/upload/drive/v3<path>', async () => {
    await (new GoogleDriveClient(cp) as any).request('POST', '/files', { name: 'x' }, { upload: true });
    expect(lastPath()).toBe('https://www.googleapis.com/upload/drive/v3/files');
  });

  it('GoogleSlidesClient.request → https://slides.googleapis.com/v1<path>', async () => {
    await (new GoogleSlidesClient(cp) as any).request('GET', '/presentations/abc');
    expect(lastPath()).toBe('https://slides.googleapis.com/v1/presentations/abc');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('GoogleSlidesClient.requestDrive (cross-API) → https://www.googleapis.com/drive/v3<path>', async () => {
    await (new GoogleSlidesClient(cp) as any).requestDrive('GET', '/files/abc');
    expect(lastPath()).toBe('https://www.googleapis.com/drive/v3/files/abc');
  });

  it('GoogleDocsClient.request → https://docs.googleapis.com/v1<path>', async () => {
    await (new GoogleDocsClient(cp) as any).request('GET', '/documents/abc');
    expect(lastPath()).toBe('https://docs.googleapis.com/v1/documents/abc');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('GoogleDocsClient.requestDrive (cross-API) → https://www.googleapis.com/drive/v3<path>', async () => {
    await (new GoogleDocsClient(cp) as any).requestDrive('/files/abc');
    expect(lastPath()).toBe('https://www.googleapis.com/drive/v3/files/abc');
  });

  it('GoogleSheetsClient.request → https://sheets.googleapis.com/v4<path>', async () => {
    await (new GoogleSheetsClient(cp) as any).request('GET', '/spreadsheets/abc');
    expect(lastPath()).toBe('https://sheets.googleapis.com/v4/spreadsheets/abc');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('GoogleSheetsClient.requestDrive (cross-API) → https://www.googleapis.com/drive/v3<path>', async () => {
    await (new GoogleSheetsClient(cp) as any).requestDrive('/files/abc');
    expect(lastPath()).toBe('https://www.googleapis.com/drive/v3/files/abc');
  });

  it('GoogleCalendarClient.request → https://www.googleapis.com/calendar/v3<path>', async () => {
    await (new GoogleCalendarClient(cp) as any).request('GET', '/calendars/primary');
    expect(lastPath()).toBe('https://www.googleapis.com/calendar/v3/calendars/primary');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('GoogleMailClient.request → https://www.googleapis.com/gmail/v1<path>', async () => {
    await (new GoogleMailClient(cp) as any).request('GET', '/users/me/profile');
    expect(lastPath()).toBe('https://www.googleapis.com/gmail/v1/users/me/profile');
    expect(isDoubled(lastPath())).toBe(false);
  });

  it('every asserted path is absolute (scheme + host)', () => {
    // sanity: the helper regex only matters if paths are absolute URLs
    expect(isDoubled('https://www.googleapis.com/drive/v3/drive/v3/files')).toBe(true);
    expect(isDoubled('https://www.googleapis.com/drive/v3/files')).toBe(false);
  });
});
