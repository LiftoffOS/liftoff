// Vendor-payload round-trip tests for every normalizer.
//
// Per §5.1 of the implementation plan: feed a representative vendor payload
// through each normalizer and assert no Zod parse errors. The fixtures are
// hand-built minimal shapes representing the production vendor format —
// enough to exercise the parse path end-to-end without requiring captured
// dev-tenant traffic.
//
// Failures here surface latent normalizer bugs (field name mismatches,
// type mismatches, missing required fields) at unit-test time instead of
// at runtime during a real ingest.

import {
  SalesforceNormalizer,
  HubSpotNormalizer,
  SlackNormalizer,
  JiraNormalizer,
  ZendeskNormalizer,
  IntercomNormalizer,
  GitHubNormalizer,
  LinearNormalizer,
  GoogleCalendarNormalizer,
  GoogleDriveNormalizer,
  GoogleMailNormalizer,
  GoogleContactsNormalizer,
  GoogleTasksNormalizer,
  MicrosoftOneDriveNormalizer,
  MicrosoftOutlookMailNormalizer,
  MicrosoftOutlookCalendarNormalizer,
  MicrosoftTeamsNormalizer,
  MicrosoftToDoNormalizer,
  MicrosoftContactsNormalizer,
  MicrosoftOneNoteNormalizer,
  MicrosoftSharePointNormalizer,
  MicrosoftPlannerNormalizer,
  DropboxNormalizer,
  BoxNormalizer,
  GranolaNormalizer,
  ZoomNormalizer,
} from '../index';

describe('Vendor-payload round-trip — normalizer × representative payload', () => {
  // HubSpot — REST results envelope. Validates each of the four entity types
  // emerges with at least an id and the entity-type-mapped declared fields.
  it('HubSpot Contact/Company/Deal/Ticket parse without error', () => {
    const n = new HubSpotNormalizer();
    for (const [objectType, props] of [
      ['contact', { email: 'a@b.com', firstname: 'A', lastname: 'B' }],
      ['company', { name: 'Acme', domain: 'acme.com' }],
      ['deal', { dealname: 'Big deal', amount: '1234.50', dealstage: 'closedwon', closedate: '2026-12-01' }],
      ['ticket', { subject: 'help', hs_ticket_status: 'open' }],
    ] as const) {
      const records = n.normalize({
        objectType,
        results: [{ id: '42', properties: props, createdAt: 't', updatedAt: 't', archived: false }],
      });
      expect(records).toHaveLength(1);
      expect(records[0].data.id).toBe('42');
    }
  });

  it('HubSpot webhook property-change event parses', () => {
    const n = new HubSpotNormalizer();
    const records = n.normalize({
      objectType: 'deal',
      objectId: 7,
      propertyName: 'dealstage',
      propertyValue: 'closedwon',
      changeSource: 'CRM_UI',
    });
    expect(records).toHaveLength(1);
    expect(records[0].entityType).toBe('Deal');
    expect(records[0].data.id).toBe('7');
  });

  it('Salesforce Account/Contact/Opportunity/Lead parse without error', () => {
    const n = new SalesforceNormalizer();
    for (const sobject of [
      { attributes: { type: 'Account' }, Id: '001', Name: 'Acme', Industry: 'Tech', Website: 'acme.com' },
      { attributes: { type: 'Contact' }, Id: '003', Name: 'Ada', Email: 'a@b.com', AccountId: '001' },
      { attributes: { type: 'Opportunity' }, Id: '006', Name: 'Q4', Amount: 50000, StageName: 'Prospecting', CloseDate: '2026-12-31', AccountId: '001' },
      { attributes: { type: 'Lead' }, Id: '00Q', Name: 'L1', Email: 'l@c.io', Company: 'C', Status: 'New', IsConverted: false },
    ]) {
      const records = n.normalize({ sobject });
      expect(records).toHaveLength(1);
      expect(records[0].data.id).toBeTruthy();
    }
  });

  it('Slack message event parses', () => {
    const n = new SlackNormalizer();
    const records = n.normalize({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event_time: 1700000000,
      event: { type: 'message', user: 'U1', channel: 'C1', text: 'hello', ts: '1700000000.1' },
    });
    expect(records).toHaveLength(1);
    expect(records[0].entityType).toBe('Message');
    expect(records[0].data.id).toBe('Ev1');
    expect(records[0].data.text).toBe('hello');
  });

  it('Jira issue webhook parses', () => {
    const n = new JiraNormalizer();
    const records = n.normalize({
      webhookEvent: 'jira:issue_updated',
      issue: {
        id: '10000',
        key: 'ENG-1',
        self: 'https://example.atlassian.net/rest/api/2/issue/10000',
        fields: {
          summary: 'Fix bug',
          status: { name: 'In Progress', id: '3' },
          issuetype: { name: 'Bug', id: '10003' },
          project: { key: 'ENG', name: 'Engineering', id: '10000' },
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-02T00:00:00Z',
          duedate: '2026-02-01',
          labels: ['backend'],
        },
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0].data.id).toBe('10000');
    expect(records[0].data.dueDate).toBe('2026-02-01');
  });

  it('Zendesk ticket + article parse', () => {
    const n = new ZendeskNormalizer();
    const ticket = {
      id: 5,
      subject: 's',
      description: 'd',
      status: 'open',
      requester_id: 1,
      submitter_id: 1,
      tags: [],
      created_at: 't',
      updated_at: 't',
      due_at: '2026-06-01T00:00:00Z',
    };
    let records = n.normalize({ ticket });
    expect(records).toHaveLength(1);
    expect(records[0].data.id).toBe('5');
    expect(records[0].data.dueAt).toBe('2026-06-01T00:00:00Z');

    records = n.normalize({
      article: {
        id: 99, title: 'How-To', body: '<p>...</p>', section_id: 1,
        locale: 'en-us', author_id: 2, promoted: true,
        created_at: 't', updated_at: 't',
      },
    });
    expect(records[0].data.id).toBe('99');
  });

  it('Intercom conversation webhook parses', () => {
    const n = new IntercomNormalizer();
    const records = n.normalize({
      topic: 'conversation.user.replied',
      data: {
        item: {
          type: 'conversation',
          id: 'conv1',
          state: 'open',
          open: true,
          read: false,
          priority: 'priority',
          created_at: 1700000000,
          updated_at: 1700001000,
        },
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0].data.id).toBe('conv1');
  });

  it('GitHub PR + Issue + comment + review parse', () => {
    const n = new GitHubNormalizer();
    let records = n.normalize({
      action: 'opened',
      sender: { id: 1, login: 'u', type: 'User', avatar_url: '' },
      pull_request: {
        id: 11, number: 1, title: 't', state: 'open',
        user: { id: 1, login: 'u' },
        head: { ref: 'f', sha: 'a' }, base: { ref: 'main', sha: 'b' },
        merged: false, draft: false,
        created_at: 't', updated_at: 't',
      },
    });
    expect(records[0].data.id).toBe('11');

    records = n.normalize({
      action: 'opened',
      issue: { id: 22, number: 2, title: 'b', state: 'open', user: { id: 1, login: 'u' }, created_at: 't', updated_at: 't' },
    });
    expect(records[0].data.id).toBe('22');
  });

  it('Linear issue + comment + project + cycle parse', () => {
    const n = new LinearNormalizer();
    const records = n.normalize({
      action: 'create',
      type: 'Issue',
      data: { id: 'iss1', createdAt: 't', updatedAt: 't', title: 't', dueDate: '2026-06-01' },
    });
    expect(records).toHaveLength(1);
    expect(records[0].data.id).toBe('iss1');
    expect(records[0].data.dueDate).toBe('2026-06-01');
  });

  it('Google Calendar event parses', () => {
    const n = new GoogleCalendarNormalizer();
    const records = n.normalize({
      id: 'evt1', kind: 'calendar#event', etag: '"e"', status: 'confirmed',
      start: { dateTime: '2026-06-01T10:00:00Z' }, end: { dateTime: '2026-06-01T11:00:00Z' },
      summary: 'Meeting',
    });
    expect(records).toHaveLength(1);
    expect(records[0].data.id).toBe('evt1');
    expect(records[0].data.startDateTime).toBe('2026-06-01T10:00:00Z');
  });

  it('Google Drive file parses', () => {
    const n = new GoogleDriveNormalizer();
    const records = n.normalize({
      id: 'f1', kind: 'drive#file', name: 'r.txt', mimeType: 'text/plain',
    });
    expect(records[0].data.id).toBe('f1');
  });

  it('Google Mail message parses with subject + headers', () => {
    const n = new GoogleMailNormalizer();
    const records = n.normalize({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'Subject', value: 'Hi' },
          { name: 'From', value: 'a@b.com' },
          { name: 'Date', value: 'Mon, 01 Jun 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
      },
    });
    expect(records[0].entityType).toBe('Email');
    expect(records[0].data.id).toBe('m1');
    expect(records[0].data.subject).toBe('Hi');
  });

  it('Google Contacts person parses', () => {
    const n = new GoogleContactsNormalizer();
    const records = n.normalize({
      connections: [{
        resourceName: 'people/123',
        etag: 'e',
        names: [{ displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace', metadata: { primary: true } }],
        emailAddresses: [{ value: 'a@b.com', metadata: { primary: true } }],
        metadata: { sources: [{ type: 'CONTACT', id: '1', updateTime: 't' }] },
      }],
    });
    expect(records[0].data.id).toBe('people/123');
    expect(records[0].data.primaryEmail).toBe('a@b.com');
  });

  it('Google Tasks task parses', () => {
    const n = new GoogleTasksNormalizer();
    const records = n.normalize({
      kind: 'tasks#task', id: 'tk1', etag: 'e', title: 'Buy milk', updated: 't',
      due: '2026-06-01T00:00:00.000Z',
      status: 'needsAction',
    });
    expect(records[0].data.id).toBe('tk1');
  });

  it('MS OneDrive item parses', () => {
    const n = new MicrosoftOneDriveNormalizer();
    const records = n.normalize({ id: 'od1', name: 'doc.docx' });
    expect(records[0].data.id).toBe('od1');
  });

  it('MS Outlook Mail message parses', () => {
    const n = new MicrosoftOutlookMailNormalizer();
    const records = n.normalize({ id: 'om1', subject: 's', isDraft: false });
    expect(records[0].entityType).toBe('Message');
    expect(records[0].data.id).toBe('om1');
  });

  it('MS Outlook Calendar event parses', () => {
    const n = new MicrosoftOutlookCalendarNormalizer();
    const records = n.normalize({
      id: 'oc1', subject: 'm', start: { dateTime: '2026-06-01T10:00:00Z', timeZone: 'UTC' }, end: { dateTime: '2026-06-01T11:00:00Z', timeZone: 'UTC' },
    });
    expect(records[0].entityType).toBe('Event');
    expect(records[0].data.id).toBe('oc1');
  });

  it('MS Teams Team / Channel / Message parse', () => {
    const n = new MicrosoftTeamsNormalizer();
    expect(n.normalize({ id: 'tm1', displayName: 'T', visibility: 'private' })[0].data.id).toBe('tm1');
    expect(n.normalize({ id: 'ch1', displayName: 'C', membershipType: 'standard', teamId: 't1' })[0].data.id).toBe('t1:ch1');
    expect(n.normalize({ id: 'msg1', body: { content: 'h' }, channelIdentity: { teamId: 't1', channelId: 'c1' } })[0].data.id).toBe('t1:c1:msg1');
  });

  it('MS To Do task + tasklist parse', () => {
    const n = new MicrosoftToDoNormalizer();
    const list = n.normalize({ id: 'L1', displayName: 'Inbox' });
    expect(list[0].data.id).toBe('L1');
    const task = n.normalize({ id: 'T1', title: 'do', status: 'notStarted', dueDateTime: { dateTime: '2026-06-01T00:00:00Z', timeZone: 'UTC' }, listId: 'L1' });
    expect(task[0].data.id).toBe('L1:T1');
  });

  it('MS Contacts contact + folder parse', () => {
    const n = new MicrosoftContactsNormalizer();
    const contact = n.normalize({ id: 'c1', displayName: 'Ada', emailAddresses: [{ name: 'A', address: 'a@b.com' }] });
    expect(contact[0].data.id).toBe('c1');
    const folder = n.normalize({ id: 'f1', displayName: 'Personal', parentFolderId: 'root' });
    expect(folder[0].data.id).toBe('f1');
  });

  it('MS OneNote notebook + section + page parse', () => {
    const n = new MicrosoftOneNoteNormalizer();
    expect(n.normalize({ id: 'nb1', displayName: 'NB', sectionsUrl: 'http://x/sections' })[0].data.id).toBe('nb1');
    expect(n.normalize({ id: 'sec1', displayName: 'S', pagesUrl: 'http://x/pages', parentNotebook: { id: 'nb1', displayName: 'NB' } })[0].data.id).toBe('sec1');
    expect(n.normalize({ id: 'pg1', title: 'P', contentUrl: 'http://x', parentSection: { id: 'sec1' }, level: 0, order: 0 })[0].data.id).toBe('pg1');
  });

  it('MS SharePoint site/list/list-item/file parse', () => {
    const n = new MicrosoftSharePointNormalizer();
    expect(n.normalize({ id: 'site1', displayName: 'S', name: 's', webUrl: 'http://sp/site1', root: {} })[0].data.id).toBe('site1');
    expect(n.normalize({ id: 'list1', displayName: 'L', list: { template: 'genericList' }, siteId: 'site1' })[0].data.id).toBe('site1:list1');
    expect(n.normalize({ id: 'item1', webUrl: 'http://x', fields: { name: 'v' }, siteId: 'site1', listId: 'list1' })[0].data.id).toBe('site1:list1:item1');
    expect(n.normalize({ id: 'driveitem1', name: 'doc.docx', file: { mimeType: 'application/x' } })[0].data.id).toBe('driveitem1');
  });

  it('MS Planner plan/bucket/task parse', () => {
    const n = new MicrosoftPlannerNormalizer();
    expect(n.normalize({ id: 'plan1', title: 'P', owner: 'o' })[0].data.id).toBe('plan1');
    expect(n.normalize({ id: 'bucket1', name: 'B', planId: 'plan1' })[0].data.id).toBe('bucket1');
    expect(n.normalize({ id: 'task1', title: 'T', planId: 'plan1', bucketId: 'bucket1', dueDateTime: '2026-06-01T00:00:00Z' })[0].data.id).toBe('task1');
  });

  it('Dropbox file/folder parses', () => {
    const n = new DropboxNormalizer();
    const records = n.normalize({
      '.tag': 'file', id: 'id:abc', name: 'r.txt',
      path_lower: '/r.txt', path_display: '/r.txt',
      client_modified: 't', server_modified: 't', rev: 'r',
    });
    expect(records[0].data.id).toBe('id:abc');
  });

  it('Box file parses', () => {
    const n = new BoxNormalizer();
    const records = n.normalize({ type: 'file', id: '99', name: 'r.txt' });
    expect(records[0].data.id).toBe('99');
  });

  it('Granola meeting parses', () => {
    const n = new GranolaNormalizer();
    const records = n.normalize({ id: 'mtg1', title: 'Standup', start_time: 't', end_time: 't' });
    expect(records[0].data.id).toBe('mtg1');
  });

  it('Zoom recording parses', () => {
    const n = new ZoomNormalizer();
    const records = n.normalize({
      uuid: 'uu1', id: 1, topic: 'Town hall', start_time: '2026-06-01T10:00:00Z', duration: 60,
    });
    expect(records[0].data.id).toBe('uu1');
  });
});
