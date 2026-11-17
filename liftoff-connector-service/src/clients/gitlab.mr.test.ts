// GitLabClient merge-request tools — native REST (the review roles' surface).
// These run over GitLab's documented v4 REST API with the connector's `api`
// token (NOT the vendor MCP, which needs an mcp-scope DCR token). Mirrors the
// mock harness in gitlab.polling.test.ts: a stub CredentialStore feeds the
// OAuthTokenProvider a fixed bearer, and global.fetch is spied per call.

import { GitLabClient } from './gitlab.js';
import type { CredentialStore } from '../mcp/credential-store.js';

const credentialStore = {
  getCredentials: async () => ({ accessToken: 'glpat_test' }),
  refreshOAuthToken: async () => ({ accessToken: 'glpat_test', expiresInMs: 3600_000 }),
} as unknown as CredentialStore;

// apiFetch reads res.ok + res.text() (it JSON.parses the text itself).
function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function newClient() {
  return new GitLabClient({ tenantId: 't1', credentialStore });
}

describe('GitLabClient MR tools (native REST)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('create_merge_request POSTs to /projects/<url-encoded>/merge_requests and returns the iid', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse({ iid: 7, web_url: 'https://gitlab.com/g/r/-/merge_requests/7' }, 201));
    const res = await newClient().create('merge_request', {
      project: 'group/repo', source_branch: 'feat', target_branch: 'main', title: 'My MR', description: 'body',
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    // "group/repo" must be URL-encoded into the single :id path segment.
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer glpat_test');
    expect(JSON.parse(init.body as string)).toMatchObject({
      source_branch: 'feat', target_branch: 'main', title: 'My MR', description: 'body',
    });
    expect(res).toEqual({ success: true, id: '7', data: expect.objectContaining({ iid: 7 }) });
  });

  it('create_merge_request returns success:false on an API error — never a fabricated success (INV-4)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse({ message: '409 conflict' }, 409));
    const res = await newClient().create('merge_request', {
      project: '123', source_branch: 'a', target_branch: 'main', title: 't',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('409');
  });

  it('create_merge_request validates required fields before any HTTP call', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const res = await newClient().create('merge_request', { project: '123', title: 't' });
    expect(res.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('create_merge_request_note POSTs the body to the notes endpoint', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse({ id: 999 }, 201));
    const res = await newClient().create('merge_request_note', { project: '42', merge_request_iid: '3', body: 'LGTM' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gitlab.com/api/v4/projects/42/merge_requests/3/notes');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'LGTM' });
    expect(res).toEqual({ success: true, id: '999', data: expect.objectContaining({ id: 999 }) });
  });

  it('get_merge_request GETs the MR and returns it as an ExternalRecord', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse({ iid: 5, title: 'x', state: 'opened' }));
    const rec = await newClient().read('merge_request', undefined, { project: 'group/repo', merge_request_iid: '5' });
    expect(spy.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/5');
    expect(rec).toEqual({ id: '5', data: expect.objectContaining({ iid: 5 }) });
  });

  it('get_merge_request_diffs GETs /diffs and wraps the array under data.diffs', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse([{ new_path: 'a.ts', diff: '@@ -1 +1 @@' }]));
    const rec = await newClient().read('merge_request_diffs', undefined, { project: '9', merge_request_iid: '2' });
    expect(spy.mock.calls[0][0]).toContain('/projects/9/merge_requests/2/diffs');
    expect((rec.data.diffs as unknown[])).toHaveLength(1);
  });

  it('get_merge_request_notes GETs /notes and wraps the array under data.notes', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse([{ id: 1, body: 'hi' }]));
    const rec = await newClient().read('merge_request_notes', undefined, { project: '9', merge_request_iid: '2' });
    expect(spy.mock.calls[0][0]).toContain('/projects/9/merge_requests/2/notes');
    expect((rec.data.notes as unknown[])).toHaveLength(1);
  });

  it('read throws on a non-2xx so the executor can classify it', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse({ message: '404 Not Found' }, 404));
    await expect(
      newClient().read('merge_request', undefined, { project: '9', merge_request_iid: '404' }),
    ).rejects.toThrow('404');
  });

  it('read/create require both project and merge_request_iid', async () => {
    await expect(newClient().read('merge_request', undefined, { merge_request_iid: '5' })).rejects.toThrow('project');
    await expect(newClient().read('merge_request', undefined, { project: '9' })).rejects.toThrow('merge_request_iid');
    expect((await newClient().create('merge_request_note', { project: '9', body: 'x' })).error).toContain('merge_request_iid');
  });

  it('rejects an unsupported entity type on both read and create', async () => {
    await expect(newClient().read('pipeline', undefined, { project: '9', merge_request_iid: '1' })).rejects.toThrow('unsupported');
    expect((await newClient().create('pipeline', { project: '9' })).error).toContain('unsupported');
  });
});
