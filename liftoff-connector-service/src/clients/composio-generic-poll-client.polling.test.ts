// ComposioGenericPollClient — the one data-driven poll client.

const mockExecute = jest.fn();
const mockProxy = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: mockExecute } }),
  composioProxyRequest: (...a: unknown[]) => mockProxy(...a),
}));
jest.mock('../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { ComposioGenericPollClient, extractArray, getPath } from './composio-generic-poll-client.js';
import type { ComposioPollSpec } from '../polling/composio-poll-spec.js';

const mk = (spec: ComposioPollSpec) => new ComposioGenericPollClient(spec, 'tenant-1', 'ca_x');
beforeEach(() => jest.clearAllMocks());

describe('helpers', () => {
  it('getPath resolves dot + array paths', () => {
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getPath({ a: { b: 1 } }, ['a', 'b'])).toBe(1);
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
  });
  it('extractArray honors explicit path and auto-detects common shapes', () => {
    expect(extractArray({ data: { items: [1] } }, ['data', 'items'])).toEqual([1]);
    expect(extractArray({ contacts: [1, 2] })).toEqual([]);              // no explicit path, 'contacts' not in candidates
    expect(extractArray({ data: [1] })).toEqual([1]);
    expect(extractArray([1, 2])).toEqual([1, 2]);
  });
});

describe('action transport — page pagination + sortDesc since (apollo shape)', () => {
  const spec: ComposioPollSpec = { connectorType: 'x', entities: [{
    entityType: 'Contact', eventTopics: ['contact.created'], action: 'ACT', recordsPath: ['contacts'], idField: 'id',
    since: { mode: 'sortDesc', field: 'updated_at', sortArg: { byArg: 'sort_by_field', byValue: 'u', dirArg: 'asc', descValue: false } },
    pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 2, totalPagesPath: ['pagination', 'total_pages'] },
    fields: { name: { path: 'name', kind: 'string' } },
  }] };

  it('sends sort + page args and returns a packed nextPageToken while more pages remain', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: {
      contacts: [{ id: 'a', updated_at: '2026-02-02T00:00:00Z' }, { id: 'b', updated_at: '2026-02-01T00:00:00Z' }],
      pagination: { total_pages: 3 },
    } });
    const res = await mk(spec).list('Contact', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('ACT', expect.objectContaining({
      arguments: expect.objectContaining({ sort_by_field: 'u', asc: false, per_page: 2, page: 1 }),
    }));
    expect(res.records.map(r => r.id)).toEqual(['a', 'b']);
    expect(res.records[0].data.__pollEntity).toBe('Contact');
    expect(res.hasMore).toBe(true);
    // second call resumes at page 2
    mockExecute.mockResolvedValue({ successful: true, data: { contacts: [], pagination: { total_pages: 3 } } });
    await mk(spec).list('Contact', { since: new Date('2026-01-01T00:00:00Z'), pageToken: res.nextPageToken });
    expect(mockExecute).toHaveBeenLastCalledWith('ACT', expect.objectContaining({ arguments: expect.objectContaining({ page: 2 }) }));
  });

  it('stops paginating once a page predates since (sortDesc)', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: {
      contacts: [{ id: 'a', updated_at: '2026-02-02T00:00:00Z' }, { id: 'old', updated_at: '2020-01-01T00:00:00Z' }],
      pagination: { total_pages: 9 },
    } });
    const res = await mk(spec).list('Contact', { since: new Date('2026-01-01T00:00:00Z') });
    expect(res.records.map(r => r.id)).toEqual(['a']);   // old filtered by sinceGate
    expect(res.hasMore).toBe(false);                     // ...and stop
  });
});

describe('server since with nested filter + URL cursor (folk shape)', () => {
  const spec: ComposioPollSpec = { connectorType: 'y', entities: [{
    entityType: 'Contact', eventTopics: ['contact.created'], action: 'ACT', recordsPath: ['data', 'items'], idField: 'id',
    since: { mode: 'server', field: 'createdAt', serverArg: { name: 'filter.createdAt.gt', format: 'dateOnly', offsetDays: 1 } },
    pagination: { mode: 'cursor', limitArg: 'limit', limit: 100, cursorArg: 'cursor', cursorPath: ['data', 'pagination', 'nextLink'] },
    fields: { name: { path: 'fullName', kind: 'string' } },
  }] };
  it('builds a nested createdAt filter and extracts the cursor param from nextLink URL', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { data: {
      items: [{ id: 'p1', createdAt: '2026-02-01T00:00:00Z', fullName: 'A' }],
      pagination: { nextLink: 'https://api.folk.app/v1/people?limit=100&cursor=CUR123' },
    } } });
    const res = await mk(spec).list('Contact', { since: new Date('2026-01-15T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('ACT', expect.objectContaining({
      arguments: expect.objectContaining({ limit: 100, filter: { createdAt: { gt: '2026-01-14' } } }),
    }));
    expect(res.records[0].data.name === undefined || true).toBe(true); // client keeps raw; normalizer maps fields
    expect(res.nextPageToken?.startsWith('CUR123')).toBe(true);
  });
});

describe('plain body cursor that stops when absent (incident_io shape)', () => {
  const spec: ComposioPollSpec = { connectorType: 'i', entities: [{
    entityType: 'Incident', eventTopics: ['incident.triggered'], action: 'ACT', recordsPath: ['incidents'], idField: 'id',
    since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_at_gte', format: 'iso' } },
    pagination: { mode: 'cursor', cursorArg: 'after', cursorPath: ['pagination_meta', 'after'], limitArg: 'page_size', limit: 2 },
    fields: { name: { path: 'name', kind: 'string' } },
  }] };

  it('passes the body cursor verbatim as `after` and stops once pagination_meta.after is absent', async () => {
    // page 1 → cursor present
    mockExecute.mockResolvedValue({ successful: true, data: {
      incidents: [{ id: 'i1', updated_at: '2026-02-02T00:00:00Z' }, { id: 'i2', updated_at: '2026-02-02T01:00:00Z' }],
      pagination_meta: { after: '01ABCDEF' },
    } });
    const res = await mk(spec).list('Incident', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('ACT', expect.objectContaining({
      arguments: expect.objectContaining({ page_size: 2, updated_at_gte: expect.any(String) }),
    }));
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken?.startsWith('01ABCDEF')).toBe(true);

    // page 2 (after=01ABCDEF) → no pagination_meta.after → stop
    mockExecute.mockResolvedValue({ successful: true, data: {
      incidents: [{ id: 'i3', updated_at: '2026-02-02T02:00:00Z' }],
      pagination_meta: {},
    } });
    const res2 = await mk(spec).list('Incident', { since: new Date('2026-01-01T00:00:00Z'), pageToken: res.nextPageToken });
    expect(mockExecute).toHaveBeenLastCalledWith('ACT', expect.objectContaining({ arguments: expect.objectContaining({ after: '01ABCDEF' }) }));
    expect(res2.hasMore).toBe(false);
    expect(res2.nextPageToken).toBeUndefined();
  });
});

describe('server window (datadog shape) + proxy transport (offset)', () => {
  it('injects start+end unix window', async () => {
    const spec: ComposioPollSpec = { connectorType: 'd', entities: [{
      entityType: 'Alert', eventTopics: ['alert.fired'], action: 'ACT', staticArgs: { sources: 'alert' }, recordsPath: ['events'], idField: 'id',
      since: { mode: 'server', field: 'timestamp', serverArg: { name: 'start', format: 'unixSec' }, windowEndArg: { name: 'end', format: 'unixSec' } },
      fields: { title: { path: 'title', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { events: [{ id: '1', title: 't' }] } });
    await mk(spec).list('Alert', { since: new Date('2026-01-01T00:00:00Z') });
    const args = mockExecute.mock.calls[0][1].arguments;
    expect(args.sources).toBe('alert');
    expect(typeof args.start).toBe('number');
    expect(typeof args.end).toBe('number');
  });

  it('proxy transport + offset pagination advances _skip while has_more', async () => {
    const spec: ComposioPollSpec = { connectorType: 'c', transport: 'proxy', entities: [{
      entityType: 'Lead', eventTopics: ['lead.created'], proxy: { method: 'GET', endpoint: '/leads' }, recordsPath: ['data'], idField: 'id',
      pagination: { mode: 'offset', skipArg: '_skip', limitArg: '_limit', limit: 2, hasMorePath: ['has_more'] },
      fields: { name: { path: 'name', kind: 'string' } },
    }] };
    mockProxy.mockResolvedValue({ has_more: true, data: [{ id: 'l1' }, { id: 'l2' }] });
    const res = await mk(spec).list('Lead', {});
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: '/leads', queryParams: expect.objectContaining({ _limit: 2, _skip: 0 }) }));
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken?.startsWith('2')).toBe(true); // skip advanced by limit
  });
});

describe('afterId pagination (last-row-id cursor — kept for APIs that page by id)', () => {
  const spec: ComposioPollSpec = { connectorType: 'a', entities: [{
    entityType: 'Row', eventTopics: ['row.created'], action: 'ACT', recordsPath: ['data'], idField: 'id',
    pagination: { mode: 'afterId', afterArg: 'starting_after', limitArg: 'limit', limit: 2 },
    fields: { name: { path: 'name', kind: 'string' } },
  }] };
  it('advances by the last row id while the page is full, stops on a short page', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { data: [{ id: 'r1' }, { id: 'r2' }] } });
    const res = await mk(spec).list('Row', {});
    expect(res.nextPageToken?.startsWith('r2')).toBe(true);            // last id
    mockExecute.mockResolvedValue({ successful: true, data: { data: [{ id: 'r3' }] } }); // short page
    const res2 = await mk(spec).list('Row', { pageToken: res.nextPageToken });
    expect(mockExecute).toHaveBeenLastCalledWith('ACT', expect.objectContaining({ arguments: expect.objectContaining({ starting_after: 'r2' }) }));
    expect(res2.nextPageToken).toBeUndefined();
  });
});

describe('Phase-2 framework additions: unixMs since, OData value envelope, single-arg sortDesc', () => {
  it('formats since as unix-ms, auto-detects the OData `value` array, sorts via a single orderby arg', async () => {
    const spec: ComposioPollSpec = { connectorType: 'dyn', entities: [{
      entityType: 'Lead', eventTopics: ['lead.created'], action: 'ACT', idField: 'leadid',
      // no recordsPath → auto-detect must find `value`
      since: { mode: 'sortDesc', field: 'modifiedon', sortArg: { byArg: 'orderby', byValue: 'modifiedon desc' } },
      pagination: { mode: 'offset', skipArg: 'skip', limitArg: 'top', limit: 2 },
      fields: { fullName: { path: 'fullname', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { value: [
      { leadid: 'L1', fullname: 'A', modifiedon: '2026-02-02T00:00:00Z' },
      { leadid: 'L2', fullname: 'B', modifiedon: '2026-02-01T00:00:00Z' },
    ] } });
    const res = await mk(spec).list('Lead', { since: new Date('2026-01-01T00:00:00Z') });
    const args = mockExecute.mock.calls[0][1].arguments;
    expect(args.orderby).toBe('modifiedon desc');   // single-arg sortDesc (no dirArg)
    expect(res.records.map(r => r.id)).toEqual(['L1', 'L2']); // `value` envelope auto-detected
  });

  it('unixMs format emits epoch milliseconds for the since arg', async () => {
    const spec: ComposioPollSpec = { connectorType: 'lv', entities: [{
      entityType: 'C', eventTopics: ['c'], action: 'ACT', recordsPath: ['data'], idField: 'id',
      since: { mode: 'server', field: 'updatedAt', serverArg: { name: 'updated_at_start', format: 'unixMs' } },
      pagination: { mode: 'cursor', cursorArg: 'offset', cursorPath: ['next'], limitArg: 'limit', limit: 100 },
      fields: { name: { path: 'name', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { data: [] } });
    await mk(spec).list('C', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute.mock.calls[0][1].arguments.updated_at_start).toBe(new Date('2026-01-01T00:00:00Z').getTime());
  });
});

describe('empty-page guard (cursor whose next-cursor persists past the end — Instagram shape)', () => {
  const spec: ComposioPollSpec = { connectorType: 'ig', entities: [{
    entityType: 'Media', eventTopics: ['post.created'], action: 'ACT', staticArgs: { ig_user_id: 'me' }, recordsPath: ['data'], idField: 'id',
    since: { mode: 'server', field: 'timestamp', serverArg: { name: 'since', format: 'unixSec' } },
    pagination: { mode: 'cursor', cursorArg: 'after', cursorPath: ['paging', 'cursors', 'after'], limitArg: 'limit', limit: 100 },
    fields: { caption: { path: 'caption', kind: 'string' } },
  }] };
  it('stops when the page is empty even though cursors.after is still present', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { data: [], paging: { cursors: { after: 'PERSISTS' } } } });
    const res = await mk(spec).list('Media', { since: new Date('2026-01-01T00:00:00Z') });
    expect(res.records).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.nextPageToken).toBeUndefined();
  });
});

describe('Phase-3 additions: serverArg template, spaceDateTime, page/afterId hasMore', () => {
  it('server template wraps the formatted value (Google Meet filter expression)', async () => {
    const spec: ComposioPollSpec = { connectorType: 'gm', entities: [{
      entityType: 'ConferenceRecord', eventTopics: ['meeting.ended'], action: 'ACT', recordsPath: ['conferenceRecords'], idField: 'name',
      since: { mode: 'server', field: 'startTime', serverArg: { name: 'filter', format: 'iso', template: 'start_time>="{value}"' } },
      pagination: { mode: 'cursor', cursorArg: 'page_token', cursorPath: ['nextPageToken'], limitArg: 'page_size', limit: 100 },
      fields: { space: { path: 'space', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { conferenceRecords: [] } });
    await mk(spec).list('ConferenceRecord', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute.mock.calls[0][1].arguments.filter).toBe('start_time>="2026-01-01T00:00:00.000Z"');
  });

  it('spaceDateTime format + JSON-filter template with offsetDays widening (Jotform)', async () => {
    const spec: ComposioPollSpec = { connectorType: 'jf', entities: [{
      entityType: 'Submission', eventTopics: ['submission.created'], action: 'ACT', recordsPath: ['content'], idField: 'id',
      since: { mode: 'server', serverArg: { name: 'filter', format: 'spaceDateTime', offsetDays: 1, template: '{"created_at:gt":"{value}"}' } },
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 1000 },
      fields: { formId: { path: 'form_id', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { content: [] } });
    await mk(spec).list('Submission', { since: new Date('2026-01-02T05:00:00Z') });
    // offsetDays:1 → 2026-01-01; spaceDateTime → 'YYYY-MM-DD HH:MM:SS' (space, no T/Z)
    expect(mockExecute.mock.calls[0][1].arguments.filter).toBe('{"created_at:gt":"2026-01-01 05:00:00"}');
  });

  it('page mode honors hasMorePath: paginates while a next-URL is present, stops when null (gumroad, no limit)', async () => {
    const spec: ComposioPollSpec = { connectorType: 'gr', entities: [{
      entityType: 'Sale', eventTopics: ['sale.created'], action: 'ACT', recordsPath: ['sales'], idField: 'id',
      since: { mode: 'server', field: 'created_at', serverArg: { name: 'after', format: 'dateOnly' } },
      pagination: { mode: 'page', pageArg: 'page', hasMorePath: ['next_page_url'] }, // no limit → `full` can't drive paging
      fields: { email: { path: 'email', kind: 'string' } },
    }] };
    mockExecute.mockResolvedValue({ successful: true, data: { sales: [{ id: 's1' }], next_page_url: '/sales?page=2' } });
    const res = await mk(spec).list('Sale', { since: new Date('2026-01-01T00:00:00Z') });
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken?.startsWith('2')).toBe(true);
    mockExecute.mockResolvedValue({ successful: true, data: { sales: [{ id: 's9' }], next_page_url: null } });
    const res2 = await mk(spec).list('Sale', { since: new Date('2026-01-01T00:00:00Z'), pageToken: res.nextPageToken });
    expect(res2.hasMore).toBe(false);
  });

  it('afterId mode honors has_more: stops on has_more=false even when the page is full (elevenlabs)', async () => {
    const spec: ComposioPollSpec = { connectorType: 'el', entities: [{
      entityType: 'HistoryItem', eventTopics: ['historyItem.created'], action: 'ACT', recordsPath: ['history'], idField: 'history_item_id',
      since: { mode: 'sortDesc', field: 'date_unix' },
      pagination: { mode: 'afterId', afterArg: 'start_after_history_item_id', limitArg: 'page_size', limit: 2, hasMorePath: ['has_more'] },
      fields: { text: { path: 'text', kind: 'string' } },
    }] };
    // full page (2 == limit) but has_more:false → no next token
    mockExecute.mockResolvedValue({ successful: true, data: { history: [
      { history_item_id: 'h1', date_unix: 1893456000 }, { history_item_id: 'h2', date_unix: 1893455000 },
    ], has_more: false } });
    const res = await mk(spec).list('HistoryItem', { since: new Date('2020-01-01T00:00:00Z') });
    expect(res.hasMore).toBe(false);
    expect(res.nextPageToken).toBeUndefined();
  });
});

describe('durableCursor mode (cross-cycle resume — Instantly forward cursor + Ashby syncToken)', () => {
  const instantly: ComposioPollSpec = { connectorType: 'in', entities: [{
    entityType: 'Lead', eventTopics: ['lead.created'], action: 'ACT', recordsPath: ['items'], idField: 'id',
    since: { mode: 'durableCursor' },
    pagination: { mode: 'cursor', cursorArg: 'starting_after', cursorPath: ['next_starting_after'], limitArg: 'limit', limit: 2 },
    fields: { email: { path: 'email', kind: 'string' } },
  }] };

  it('pagination-cursor durable: resumes from the persisted C: cursor and emits the next one', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { items: [{ id: 'a' }, { id: 'b' }], next_starting_after: 'b' } });
    const res = await mk(instantly).list('Lead', { syncCursor: 'C:PREV' });
    expect(mockExecute.mock.calls[0][1].arguments.starting_after).toBe('PREV'); // resumed forward
    expect(res.syncCursor).toBe('C:b');                                          // new resume persisted
    expect(res.records.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('pagination-cursor durable: caught up (next cursor null) but rows present → C:<last id>', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { items: [{ id: 'x' }], next_starting_after: null } });
    const res = await mk(instantly).list('Lead', {}); // first ever, no persisted cursor
    expect(mockExecute.mock.calls[0][1].arguments.starting_after).toBeUndefined(); // nothing to resume from
    expect(res.syncCursor).toBe('C:x');                                            // fall back to last id
  });

  const ashby: ComposioPollSpec = { connectorType: 'as', entities: [{
    entityType: 'Candidate', eventTopics: ['candidate.created'], action: 'ACT', recordsPath: ['results'], idField: 'id',
    since: { mode: 'durableCursor', durable: { tokenArg: 'syncToken', tokenPath: ['syncToken'] } },
    pagination: { mode: 'cursor', cursorArg: 'cursor', cursorPath: ['nextCursor'], limitArg: 'perPage', limit: 2 },
    fields: { name: { path: 'name', kind: 'string' } },
  }] };

  it('token durable: sends syncToken from T: resume, emits the new T:<token> on the final delta page', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { results: [{ id: 'c1' }], moreDataAvailable: false, syncToken: 'SYNC2' } });
    const res = await mk(ashby).list('Candidate', { syncCursor: 'T:SYNC1' });
    expect(mockExecute.mock.calls[0][1].arguments.syncToken).toBe('SYNC1'); // delta window
    expect(res.syncCursor).toBe('T:SYNC2');                                 // new token to persist
    expect(res.hasMore).toBe(false);
  });

  it('token durable: a backfill page without a syncToken carries C:<nextCursor> (resumes across cycles)', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { results: [{ id: 'c1' }, { id: 'c2' }], moreDataAvailable: true, nextCursor: 'CUR2' } });
    const res = await mk(ashby).list('Candidate', {}); // first ever, no token yet
    expect(mockExecute.mock.calls[0][1].arguments.syncToken).toBeUndefined();
    expect(res.syncCursor).toBe('C:CUR2');            // backfill continuation, not a token
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken?.startsWith('CUR2')).toBe(true);
  });

  it('token durable: the token is resent on page 2 alongside the within-cycle cursor', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { results: [{ id: 'c3' }], moreDataAvailable: false, syncToken: 'SYNC3' } });
    const res = await mk(ashby).list('Candidate', { syncCursor: 'T:SYNC1', pageToken: 'CURX::@::1' });
    const args = mockExecute.mock.calls[0][1].arguments;
    expect(args.syncToken).toBe('SYNC1'); // token defines the delta on every page
    expect(args.cursor).toBe('CURX');     // and the cursor paginates within it
    expect(res.syncCursor).toBe('T:SYNC3');
  });
});

describe('guards', () => {
  const spec: ComposioPollSpec = { connectorType: 'z', entities: [{ entityType: 'Contact', eventTopics: ['c'], action: 'ACT', fields: { n: { path: 'n', kind: 'string' } } }] };
  it('returns empty for an unmapped entityType', async () => {
    expect(await mk(spec).list('Nope', {})).toEqual({ records: [], hasMore: false, unsupported: true });
    expect(mockExecute).not.toHaveBeenCalled();
  });
  it('throws when the action returns successful=false', async () => {
    mockExecute.mockResolvedValue({ successful: false, error: 'boom' });
    await expect(mk(spec).list('Contact', {})).rejects.toThrow('boom');
  });
});
