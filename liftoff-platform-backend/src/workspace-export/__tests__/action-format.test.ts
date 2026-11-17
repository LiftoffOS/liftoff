// The port of the review page's presentation functions, held to the page's
// own fixtures (Liftoff-React src/utils/toolCallDetails.test.ts), and to the
// two ways the port is stricter than the page.

import {
  describeToolCall,
  toDetailFields,
  redactSecrets,
  detailFieldsToObject,
  detailNote,
  scrubKnownIds,
} from '../action-format';

describe('describeToolCall (page fixtures)', () => {
  it('splits a connector tool into vendor and action', () => {
    expect(describeToolCall('mcp__github-7d07a896__merge_pull_request')).toEqual({
      connector: 'GitHub',
      action: 'Merge pull request',
    });
  });

  it('keeps every vendor word, not just the first', () => {
    expect(describeToolCall('mcp__google-mail-eaec0c30__send_message')).toEqual({
      connector: 'Google Mail',
      action: 'Send message',
    });
  });

  it('drops a hyphenated tenant id from the platform server alias', () => {
    expect(
      describeToolCall('mcp__liftoff-tools-dd7d80bd-85cc-4adf-8293-ee623ce27f46__record_step_output'),
    ).toEqual({ connector: 'Liftoff', action: 'Record step output' });
  });

  it('reports a bare platform operation with no connector', () => {
    expect(describeToolCall('export_all_data')).toEqual({ connector: null, action: 'Export all data' });
  });
});

describe('toDetailFields (page fixtures)', () => {
  it('labels top-level arguments and writes their values out', () => {
    expect(toDetailFields({ to: 'ops@bigcorp.example', subject: 'Your renewal options', pullNumber: 482 })).toEqual([
      { path: 'to', label: 'To', depth: 0, value: 'ops@bigcorp.example' },
      { path: 'subject', label: 'Subject', depth: 0, value: 'Your renewal options' },
      { path: 'pullNumber', label: 'Pull number', depth: 0, value: '482' },
    ]);
  });

  it('renders a nested object as a heading plus indented children', () => {
    expect(toDetailFields({
      category: { type: 'general', urgency: 'Low', sensitive: false, prior_agent_replies: 0 },
    })).toEqual([
      { path: 'category', label: 'Category', depth: 0, value: null },
      { path: 'category.type', label: 'Type', depth: 1, value: 'general' },
      { path: 'category.urgency', label: 'Urgency', depth: 1, value: 'Low' },
      { path: 'category.sensitive', label: 'Sensitive', depth: 1, value: 'No' },
      { path: 'category.prior_agent_replies', label: 'Prior agent replies', depth: 1, value: '0' },
    ]);
  });

  it('keeps a list of plain values on one line', () => {
    expect(toDetailFields({ cc: ['a@example.com', 'b@example.com'] })).toEqual([
      { path: 'cc', label: 'CC', depth: 0, value: 'a@example.com, b@example.com' },
    ]);
  });

  it('uppercases known acronyms in a label', () => {
    expect(toDetailFields({ spreadsheetId: 'abc' })[0].label).toBe('Spreadsheet ID');
  });

  it('reports an absent value rather than dropping the argument', () => {
    expect(toDetailFields({ note: null, tags: [] }).map((f) => f.value)).toEqual(['None', 'None']);
  });

  it('never shows a secret-bearing argument', () => {
    const fields = toDetailFields({ apiKey: 'sk-live-1234', auth: { token: 'abc' } });
    expect(fields.find((f) => f.path === 'apiKey')?.value).toBe('Hidden');
    expect(fields.find((f) => f.path === 'auth.token')?.value).toBe('Hidden');
    expect(JSON.stringify(fields)).not.toContain('sk-live-1234');
  });

  it('is STRICTER than the page past the depth limit: Hidden, never compact JSON', () => {
    // The page collapses this to '{"d":1}' (toolCallDetails.ts:224-226); a
    // file leaves the building, so the port hides what it will not walk.
    const fields = toDetailFields({ a: { b: { c: { d: 1 } } } });
    expect(fields[fields.length - 1]).toEqual({ path: 'a.b.c', label: 'C', depth: 2, value: 'Hidden' });
    expect(JSON.stringify(fields)).not.toContain('"d"');
  });

  it('truncates a very long value', () => {
    const value = toDetailFields({ body: 'x'.repeat(500) })[0].value ?? '';
    expect(value.endsWith('…')).toBe(true);
    expect(value.length).toBeLessThan(300);
  });

  it('returns nothing for a call with no arguments', () => {
    expect(toDetailFields({})).toEqual([]);
    expect(toDetailFields(null)).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('replaces secret values at every depth and leaves the rest alone (page fixture)', () => {
    expect(
      redactSecrets({ owner: 'acme', headers: { authorization: 'Bearer x' }, list: [{ password: 'p' }] }),
    ).toEqual({ owner: 'acme', headers: { authorization: 'Hidden' }, list: [{ password: 'Hidden' }] });
  });

  it('is STRICTER than the page past depth eight: a secret nested nine levels deep is Hidden', () => {
    const nine = { a: { b: { c: { d: { e: { f: { g: { h: { i: { token: 'sk-deep-secret' } } } } } } } } } };
    const out = JSON.stringify(redactSecrets(nine));
    expect(out).not.toContain('sk-deep-secret');
    expect(out).toContain('Hidden');
    // And through the whole Details path.
    const details = detailFieldsToObject(toDetailFields(redactSecrets(nine) as Record<string, unknown>));
    expect(JSON.stringify(details)).not.toContain('sk-deep-secret');
  });
});

describe('detailFieldsToObject', () => {
  it('nests a heading row\'s children under its label', () => {
    expect(detailFieldsToObject(toDetailFields({
      channel: '#announcements', text: 'Release 2.14 is live.', options: { pin: true, mentions: ['ops'] },
    }))).toEqual({
      Channel: '#announcements',
      Text: 'Release 2.14 is live.',
      Options: { Pin: 'Yes', Mentions: 'ops' },
    });
  });

  it('keeps two arguments that share a label', () => {
    expect(detailFieldsToObject(toDetailFields({ user_id: 'a', userId: 'b' }))).toEqual({
      'User ID': 'a',
      'User ID (2)': 'b',
    });
  });
});

describe('scrubKnownIds', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const CONNECTOR = '33333333-3333-4333-8333-333333333333';
  const INVOCATION = '44444444-4444-4444-8444-444444444444';
  const known = new Map<string, string | null>([
    [TENANT, null],
    [ACCOUNT, 'Alex Rivera'],
    [CONNECTOR, 'GitHub'],
    [INVOCATION, null],
  ]);

  it('replaces exact matches of known ids with the resolved name or Hidden, at any depth', () => {
    expect(scrubKnownIds({
      Tenant: TENANT,
      Owner: ACCOUNT,
      Nested: { Connector: CONNECTOR, List: [INVOCATION, 'plain'] },
    }, known)).toEqual({
      Tenant: 'Hidden',
      Owner: 'Alex Rivera',
      Nested: { Connector: 'GitHub', List: ['Hidden', 'plain'] },
    });
  });

  it('never alters a person\'s text, even when it contains a UUID that is not a known id', () => {
    const text = `Please look at ticket 55555555-5555-4555-8555-555555555555 and ${ACCOUNT} together`;
    expect(scrubKnownIds({ Text: text }, known)).toEqual({ Text: text });
  });
});

describe('detailNote (page fixtures)', () => {
  const call = { name: 'mcp__liftoff-tools-dd7d80bd__record_step_output' };

  it('drops the flattened line, which the rendered arguments already say', () => {
    const detail =
      'liftoff · record_step_output — category {"type":"general","urgency":"Low","sensitive":false,"prior_agent_replies":0,"sum…';
    expect(detailNote(detail, [call])).toBeNull();
  });

  it('keeps the blast-radius measurement appended to that line', () => {
    const detail =
      'hubspot · batch_update_contacts — objectType contacts — This single action would affect 142 items (limit 50). This run would have affected 142 items in total (limit 100).';
    expect(detailNote(detail, [{ name: 'mcp__hubspot-b81d4f27__batch_update_contacts' }])).toBe(
      'This single action would affect 142 items (limit 50). This run would have affected 142 items in total (limit 100).',
    );
  });

  it('keeps a flattened line that carries no arguments and no measurement out of the archive', () => {
    expect(detailNote('github · merge_pull_request', [{ name: 'mcp__github-7d07a896__merge_pull_request' }])).toBeNull();
  });

  it('shows the free prose an older row carries, whole', () => {
    const prose = 'Salesforce keeps deleted records in the recycle bin for 15 days.';
    expect(detailNote(prose, [{ name: 'mcp__salesforce-4b71e0c9__delete_record' }])).toBe(prose);
  });

  it('has nothing to say for an empty or missing detail', () => {
    expect(detailNote(null, [call])).toBeNull();
    expect(detailNote('   ', [call])).toBeNull();
  });

  it('shows the detail when there is no call to recognise the line by', () => {
    expect(detailNote('Something the gate wrote.', [])).toBe('Something the gate wrote.');
  });
});
