import { describe, it, expect } from 'vitest'
import { describeToolCall, detailNote, redactSecrets, toDetailFields } from './toolCallDetails'

describe('describeToolCall', () => {
  it('splits a connector tool into vendor and action', () => {
    expect(describeToolCall('mcp__github-7d07a896__merge_pull_request')).toEqual({
      connector: 'GitHub',
      action: 'Merge pull request',
    })
  })

  it('keeps every vendor word, not just the first', () => {
    // The runtime's own flattened line cuts the alias at the first hyphen and
    // calls this "google". The instance id is the only part worth dropping.
    expect(describeToolCall('mcp__google-mail-eaec0c30__send_message')).toEqual({
      connector: 'Google Mail',
      action: 'Send message',
    })
  })

  it('drops a hyphenated tenant id from the platform server alias', () => {
    expect(
      describeToolCall('mcp__liftoff-tools-dd7d80bd-85cc-4adf-8293-ee623ce27f46__record_step_output'),
    ).toEqual({ connector: 'Liftoff', action: 'Record step output' })
  })

  it('reports a bare platform operation with no connector', () => {
    expect(describeToolCall('export_all_data')).toEqual({
      connector: null,
      action: 'Export all data',
    })
  })
})

describe('toDetailFields', () => {
  it('labels top-level arguments and writes their values out', () => {
    const fields = toDetailFields({
      to: 'ops@bigcorp.example',
      subject: 'Your renewal options',
      pullNumber: 482,
    })
    expect(fields).toEqual([
      { path: 'to', label: 'To', depth: 0, value: 'ops@bigcorp.example' },
      { path: 'subject', label: 'Subject', depth: 0, value: 'Your renewal options' },
      { path: 'pullNumber', label: 'Pull number', depth: 0, value: '482' },
    ])
  })

  it('renders a nested object as a heading plus indented children', () => {
    // The reported case: one argument, an object, which the runtime flattened
    // into `category {"type":"general","urgency":"Low",…`.
    const fields = toDetailFields({
      category: {
        type: 'general',
        urgency: 'Low',
        sensitive: false,
        prior_agent_replies: 0,
      },
    })
    expect(fields).toEqual([
      { path: 'category', label: 'Category', depth: 0, value: null },
      { path: 'category.type', label: 'Type', depth: 1, value: 'general' },
      { path: 'category.urgency', label: 'Urgency', depth: 1, value: 'Low' },
      { path: 'category.sensitive', label: 'Sensitive', depth: 1, value: 'No' },
      { path: 'category.prior_agent_replies', label: 'Prior agent replies', depth: 1, value: '0' },
    ])
  })

  it('keeps a list of plain values on one line', () => {
    const fields = toDetailFields({ cc: ['a@example.com', 'b@example.com'] })
    expect(fields).toEqual([
      { path: 'cc', label: 'CC', depth: 0, value: 'a@example.com, b@example.com' },
    ])
  })

  it('uppercases known acronyms in a label', () => {
    expect(toDetailFields({ spreadsheetId: 'abc' })[0].label).toBe('Spreadsheet ID')
  })

  it('reports an absent value rather than dropping the argument', () => {
    expect(toDetailFields({ note: null, tags: [] }).map((f) => f.value)).toEqual(['None', 'None'])
  })

  it('never shows a secret-bearing argument', () => {
    const fields = toDetailFields({ apiKey: 'sk-live-1234', auth: { token: 'abc' } })
    expect(fields.find((f) => f.path === 'apiKey')?.value).toBe('Hidden')
    expect(fields.find((f) => f.path === 'auth.token')?.value).toBe('Hidden')
    expect(JSON.stringify(fields)).not.toContain('sk-live-1234')
  })

  it('collapses anything nested past three levels into compact JSON', () => {
    const fields = toDetailFields({ a: { b: { c: { d: 1 } } } })
    expect(fields[fields.length - 1]).toEqual({
      path: 'a.b.c', label: 'C', depth: 2, value: '{"d":1}',
    })
  })

  it('truncates a very long value', () => {
    const value = toDetailFields({ body: 'x'.repeat(500) })[0].value ?? ''
    expect(value.endsWith('…')).toBe(true)
    expect(value.length).toBeLessThan(300)
  })

  it('returns nothing for a call with no arguments', () => {
    expect(toDetailFields({})).toEqual([])
    expect(toDetailFields(null)).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('replaces secret values at every depth and leaves the rest alone', () => {
    expect(
      redactSecrets({ owner: 'acme', headers: { authorization: 'Bearer x' }, list: [{ password: 'p' }] }),
    ).toEqual({ owner: 'acme', headers: { authorization: 'Hidden' }, list: [{ password: 'Hidden' }] })
  })
})

describe('detailNote', () => {
  const call = { name: 'mcp__liftoff-tools-dd7d80bd__record_step_output' }

  it('drops the flattened line, which the rendered arguments already say', () => {
    const detail =
      'liftoff · record_step_output — category {"type":"general","urgency":"Low","sensitive":false,"prior_agent_replies":0,"sum…'
    expect(detailNote(detail, [call])).toBeNull()
  })

  it('keeps the blast-radius measurement appended to that line', () => {
    const detail =
      'hubspot · batch_update_contacts — objectType contacts — This single action would affect 142 items (limit 50). This run would have affected 142 items in total (limit 100).'
    expect(detailNote(detail, [{ name: 'mcp__hubspot-b81d4f27__batch_update_contacts' }])).toBe(
      'This single action would affect 142 items (limit 50). This run would have affected 142 items in total (limit 100).',
    )
  })

  it('keeps a flattened line that carries no arguments and no measurement out of the panel', () => {
    expect(detailNote('github · merge_pull_request', [{ name: 'mcp__github-7d07a896__merge_pull_request' }]))
      .toBeNull()
  })

  it('shows the free prose an older row carries, whole', () => {
    const prose = 'Salesforce keeps deleted records in the recycle bin for 15 days.'
    expect(detailNote(prose, [{ name: 'mcp__salesforce-4b71e0c9__delete_record' }])).toBe(prose)
  })

  it('has nothing to say for an empty or missing detail', () => {
    expect(detailNote(null, [call])).toBeNull()
    expect(detailNote('   ', [call])).toBeNull()
  })

  it('shows the detail when there is no call to recognise the line by', () => {
    expect(detailNote('Something the gate wrote.', [])).toBe('Something the gate wrote.')
  })
})
