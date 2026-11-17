// CalendlyClient.list('Event') (native DCR-OAuth bearer polling) + normalizer tests.
//
// Calendly scopes /scheduled_events by the current user, so list() makes TWO
// calls: /users/me to resolve the user uri, then /scheduled_events?user=...

import { CalendlyClient } from './calendly.js';
import { CalendlyNormalizer } from '../normalizers/calendly.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'cal_test_token',
  tenantId: 't1',
  connectorId: 'c1',
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const USER_URI = 'https://api.calendly.com/users/USER123';

describe('CalendlyClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the user uri then maps scheduled events, sending min_start_time for incremental sync', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          resource: { uri: USER_URI, name: 'Ada', email: 'ada@x.com', current_organization: 'https://api.calendly.com/organizations/ORG1' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          collection: [
            {
              uri: 'https://api.calendly.com/scheduled_events/EVENT_ABC',
              name: 'Intro call',
              status: 'active',
              start_time: '2026-06-27T15:00:00.000000Z',
              end_time: '2026-06-27T15:30:00.000000Z',
              event_type: 'https://api.calendly.com/event_types/ET1',
              location: { type: 'zoom', join_url: 'https://zoom.us/j/123' },
              invitees_counter: { total: 1, active: 1, limit: 1 },
            },
          ],
          pagination: { count: 1, next_page_token: null },
        }),
      );

    const client = new CalendlyClient(credentialProvider);
    const res = await client.list('Event', { since: new Date('2026-06-26T00:00:00Z'), limit: 100 });

    expect(spy).toHaveBeenCalledTimes(2);

    // First call resolves the user context.
    expect(spy.mock.calls[0][0] as string).toContain('/users/me');

    // Second call lists scheduled events scoped to the user, incremental + sorted.
    const listUrl = spy.mock.calls[1][0] as string;
    expect(listUrl).toContain('/scheduled_events');
    expect(listUrl).toContain(`user=${encodeURIComponent(USER_URI)}`);
    expect(listUrl).toContain('min_start_time=2026-06-26T00%3A00%3A00.000Z');
    expect(listUrl).toContain('sort=start_time%3Aasc');

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('EVENT_ABC');
    expect(res.hasMore).toBe(false);
  });

  it('signals hasMore + passes the cursor back as page_token when a next page exists', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ resource: { uri: USER_URI, current_organization: 'org' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          collection: [{ uri: 'https://api.calendly.com/scheduled_events/E1' }],
          pagination: { count: 1, next_page_token: 'NEXT_TOK' },
        }),
      );

    const client = new CalendlyClient(credentialProvider);
    const res = await client.list('Event', { limit: 1 });

    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('NEXT_TOK');

    const listUrl = spy.mock.calls[1][0] as string;
    expect(listUrl).not.toContain('page_token'); // first page sends no cursor
  });

  it('forwards a provided pageToken as page_token', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ resource: { uri: USER_URI, current_organization: 'org' } }))
      .mockResolvedValueOnce(jsonResponse({ collection: [], pagination: { count: 0 } }));

    const client = new CalendlyClient(credentialProvider);
    await client.list('Event', { pageToken: 'PREV_TOK' });

    const listUrl = spy.mock.calls[1][0] as string;
    expect(listUrl).toContain('page_token=PREV_TOK');
  });

  it('returns empty for a non-Event entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new CalendlyClient(credentialProvider);
    expect((await client.list('Invitee')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CalendlyNormalizer', () => {
  it('normalizes a scheduled event from { results: [...] } and emits an Event', () => {
    const n = new CalendlyNormalizer();
    const recs = n.normalize({
      results: [
        {
          uri: 'https://api.calendly.com/scheduled_events/EVENT_ABC',
          name: 'Intro call',
          status: 'active',
          start_time: '2026-06-27T15:00:00.000000Z',
          end_time: '2026-06-27T15:30:00.000000Z',
          event_type: 'https://api.calendly.com/event_types/ET1',
          location: { type: 'zoom', join_url: 'https://zoom.us/j/123' },
          invitees_counter: { total: 2, active: 2, limit: 2 },
        },
      ],
    });

    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Event');
    expect(recs[0].externalId).toBe('EVENT_ABC');
    expect(recs[0].data.status).toBe('active');
    expect(recs[0].data.locationType).toBe('zoom');
    expect(recs[0].data.location).toBe('https://zoom.us/j/123');
    expect(recs[0].data.inviteeCount).toBe(2);
    expect(recs[0].metadata.source).toBe('calendly');
    expect(recs[0].metadata.version).toBe('2026-06-27T15:00:00.000000Z');
  });

  it('skips records without a uri and declares the Event schema with the startTime anchor', () => {
    const n = new CalendlyNormalizer();
    expect(n.normalize({ results: [{ status: 'active' }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Event)).toMatch(/startTime/);
  });
});
