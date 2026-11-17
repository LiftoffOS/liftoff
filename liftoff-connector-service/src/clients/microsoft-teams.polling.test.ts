// MicrosoftTeamsClient.list('Message') (joinedTeams -> channels -> messages fan-out) + normalizer .results.

import { MicrosoftTeamsClient } from './microsoft-teams.js';
import { MicrosoftTeamsNormalizer } from '../normalizers/microsoft-teams.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'graph_token', instanceUrl: undefined, tenantId: 't1', connectorId: 'c1',
});

// Sequential fetch responses for the fan-out: joinedTeams, channels, messages.
function mockFetchSequence(bodies: unknown[]) {
  const spy = jest.spyOn(global, 'fetch');
  for (const body of bodies) {
    spy.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response);
  }
  return spy;
}

// Same, but each response carries an explicit HTTP status so a 403/5xx channel
// can be injected mid-fan-out.
function mockFetchStatuses(responses: Array<{ status?: number; body: unknown }>) {
  const spy = jest.spyOn(global, 'fetch');
  for (const r of responses) {
    const status = r.status ?? 200;
    spy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300, status,
      json: async () => r.body, text: async () => JSON.stringify(r.body),
    } as unknown as Response);
  }
  return spy;
}

describe('MicrosoftTeamsClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fans out joinedTeams -> channels -> messages and filters by since', async () => {
    const spy = mockFetchSequence([
      { value: [{ id: 'team1' }] },
      { value: [{ id: 'chan1' }] },
      { value: [
        { id: 'msg_new', createdDateTime: '2026-06-26T10:00:00Z', lastModifiedDateTime: '2026-06-26T10:00:00Z', body: { content: 'hi' }, from: { user: { displayName: 'A' } } },
        { id: 'msg_old', createdDateTime: '2026-06-01T10:00:00Z', lastModifiedDateTime: '2026-06-01T10:00:00Z', body: { content: 'old' } },
      ] },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    const res = await client.list('Message', { since: new Date('2026-06-25T00:00:00Z') });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('msg_new');
    expect(res.records[0].data.teamId).toBe('team1');
    expect(res.records[0].data.channelId).toBe('chan1');
    // joinedTeams + channels + messages = 3 calls
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns empty for a non-Message entity without calling Graph', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new MicrosoftTeamsClient(credentialProvider);
    expect((await client.list('Channel')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  // A single channel the user cannot read (a private channel they are not in,
  // say) must not fail the whole poll. Before this, the first 403 threw out of
  // list() and lost every readable channel too, then flipped the connection to
  // "Needs Reconnect".
  it('skips a forbidden channel and still returns readable channels', async () => {
    mockFetchStatuses([
      { body: { value: [{ id: 'team1' }] } },
      { body: { value: [{ id: 'chanA' }, { id: 'chanB' }] } },
      { status: 403, body: { error: { code: 'Forbidden', message: 'UnknownError' } } },
      { body: { value: [{ id: 'msgB', createdDateTime: '2026-06-26T10:00:00Z', lastModifiedDateTime: '2026-06-26T10:00:00Z' }] } },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    const res = await client.list('Message', { since: new Date('2026-06-25T00:00:00Z') });

    expect(res.records.map((r) => r.id)).toEqual(['msgB']);
    expect(res.records[0].data.channelId).toBe('chanB');
  });

  // But if EVERY channel is forbidden, that is an app/user permission condition,
  // not a stray private channel — surface it rather than silently returning [].
  it('throws when every joined channel is forbidden', async () => {
    mockFetchStatuses([
      { body: { value: [{ id: 'team1' }] } },
      { body: { value: [{ id: 'chanA' }] } },
      { status: 403, body: { error: { code: 'Forbidden', message: 'UnknownError' } } },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    await expect(client.list('Message')).rejects.toThrow(/all 1 channel/);
  });

  // A transient (non-403) channel error must still propagate so the scheduler's
  // retry/backoff and failure accounting see it — only 403 is a skip.
  it('propagates a non-403 channel error instead of skipping', async () => {
    mockFetchStatuses([
      { body: { value: [{ id: 'team1' }] } },
      { body: { value: [{ id: 'chanA' }] } },
      { status: 500, body: { error: { code: 'InternalServerError' } } },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    await expect(client.list('Message')).rejects.toThrow(/500/);
  });

  // polling/scheduler.ts hands every connector `limit: 100`. Graph caps $top at
  // 50 for message collections and 400s above it, so forwarding the scheduler's
  // value unchanged makes every Teams poll fail.
  it('clamps the scheduler limit of 100 to the Graph maximum of 50', async () => {
    const spy = mockFetchSequence([
      { value: [{ id: 'team1' }] },
      { value: [{ id: 'chan1' }] },
      { value: [] },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    await client.list('Message', { limit: 100 });

    const messagesUrl = String(spy.mock.calls[2][0]);
    expect(decodeURIComponent(messagesUrl)).toContain('$top=50');
    expect(decodeURIComponent(messagesUrl)).not.toContain('$top=100');
  });

  it('passes a below-cap limit through untouched', async () => {
    const spy = mockFetchSequence([
      { value: [{ id: 'team1' }] },
      { value: [{ id: 'chan1' }] },
      { value: [] },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    await client.list('Message', { limit: 20 });

    expect(decodeURIComponent(String(spy.mock.calls[2][0]))).toContain('$top=20');
  });

  // Channel messages reject $orderby in either direction — a hard 400, never a
  // silently-reordered result. Guard the poll fan-out against any $orderby
  // (asc or desc) creeping back in.
  it('never sends $orderby on the message poll', async () => {
    const spy = mockFetchSequence([
      { value: [{ id: 'team1' }] },
      { value: [{ id: 'chan1' }] },
      { value: [] },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    await client.list('Message', { limit: 100 });

    for (const call of spy.mock.calls) {
      const url = decodeURIComponent(String(call[0]));
      expect(url).not.toContain('$orderby');
      expect(url).not.toContain('orderby');
      expect(url).not.toContain('asc');
    }
  });
});

describe('MicrosoftTeamsClient.read messages', () => {
  afterEach(() => jest.restoreAllMocks());

  // This read carried `$orderby` — first ascending, then (a later, still-wrong
  // fix) descending. Channel messages reject $orderby in EITHER direction, so it
  // 400'd its whole life. It now sends no $orderby, takes Graph's default
  // newest-first order, and reverses locally — preserving the oldest-first
  // contract a caller rendering a thread depends on.
  it('sends no $orderby and returns messages oldest-first', async () => {
    const spy = mockFetchSequence([
      { value: [
        { id: 'msg3', createdDateTime: '2026-06-03T10:00:00Z' },
        { id: 'msg2', createdDateTime: '2026-06-02T10:00:00Z' },
        { id: 'msg1', createdDateTime: '2026-06-01T10:00:00Z' },
      ] },
    ]);
    const client = new MicrosoftTeamsClient(credentialProvider);
    const res = await client.read('messages', 'team1:chan1');

    const url = decodeURIComponent(String(spy.mock.calls[0][0]));
    expect(url).not.toContain('$orderby');
    expect(url).not.toContain('orderby');
    expect(url).toContain('$top=50');

    expect(res.data.messages.map((m: { id: string }) => m.id)).toEqual(['msg1', 'msg2', 'msg3']);
  });
});

describe('MicrosoftTeamsNormalizer .results polling path', () => {
  it('normalizes scheduler-wrapped { results: [message] } rows to Message records', () => {
    const n = new MicrosoftTeamsNormalizer();
    const recs = n.normalize({
      results: [{
        id: 'msg1', teamId: 'team1', channelId: 'chan1',
        createdDateTime: '2026-06-26T10:00:00Z', lastModifiedDateTime: '2026-06-26T10:05:00Z',
        body: { content: 'hello', contentType: 'text' },
        from: { user: { id: 'u1', displayName: 'Ada' } },
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Message');
    expect(recs[0].externalId).toBe('msg1');
    expect(recs[0].metadata.source).toBe('microsoft_teams');
  });
});
