// The tool-discovery rules that let browse serve every connector without a
// per-vendor mapping.
//
// Everything downstream depends on picking the RIGHT operation from a toolkit's
// list. Two failure modes matter more than a miss:
//
//   - picking a tool for the wrong entity produces a confident, wrong list
//     (someone's invoices shown as their channels), which is worse than saying
//     nothing
//   - picking a single-record read (`get_invoice`) calls a vendor with no id and
//     surfaces a validation error to someone who only wanted to browse
//
// Both look fine in code and only show up in front of a customer, so they are
// pinned here.

import {
  entityStems,
  pickEnumeratingTool,
  extractRecordArray,
  toExternalRecords,
} from '../entity-enumeration.js';

const tool = (name: string) => ({ name });

describe('pickEnumeratingTool', () => {
  it('finds the lister for the requested entity', () => {
    const tools = [tool('AIRTABLE_LIST_BASES'), tool('AIRTABLE_CREATE_RECORD')];
    expect(pickEnumeratingTool(tools, 'bases')?.name).toBe('AIRTABLE_LIST_BASES');
  });

  it('matches singular against a plural tool name and vice versa', () => {
    expect(pickEnumeratingTool([tool('TODOIST_GET_PROJECTS')], 'project')?.name)
      .toBe('TODOIST_GET_PROJECTS');
    expect(pickEnumeratingTool([tool('MONDAY_LIST_BOARD')], 'boards')?.name)
      .toBe('MONDAY_LIST_BOARD');
  });

  it('never returns a tool for a different entity', () => {
    // The dangerous case: something IS available, just not what was asked for.
    const tools = [tool('STRIPE_LIST_INVOICES'), tool('STRIPE_LIST_CUSTOMERS')];
    expect(pickEnumeratingTool(tools, 'channels')).toBeNull();
  });

  it('refuses a single-record read that would need an id we do not have', () => {
    expect(pickEnumeratingTool([tool('XERO_GET_INVOICE')], 'invoice')).toBeNull();
  });

  it('accepts a get_all-style name even though it starts with get', () => {
    expect(pickEnumeratingTool([tool('CODA_GET_ALL_DOCS')], 'docs')?.name)
      .toBe('CODA_GET_ALL_DOCS');
  });

  it('prefers an explicit list over a vaguer match', () => {
    const tools = [tool('DISCORD_CHANNELS_METADATA'), tool('DISCORD_LIST_CHANNELS')];
    expect(pickEnumeratingTool(tools, 'channels')?.name).toBe('DISCORD_LIST_CHANNELS');
  });

  it('returns null when the toolkit publishes nothing at all', () => {
    expect(pickEnumeratingTool([], 'anything')).toBeNull();
  });
});

describe('entityStems', () => {
  it('covers the spellings a vendor might use', () => {
    expect(entityStems('companies')).toEqual(expect.arrayContaining(['companies', 'company']));
    expect(entityStems('boards')).toEqual(expect.arrayContaining(['boards', 'board']));
  });
});

describe('extractRecordArray', () => {
  it('takes a bare array', () => {
    expect(extractRecordArray([{ id: '1' }])).toHaveLength(1);
  });

  it('unwraps a single-key envelope', () => {
    expect(extractRecordArray({ items: [{ id: '1' }, { id: '2' }] })).toHaveLength(2);
  });

  it('unwraps a nested envelope', () => {
    expect(extractRecordArray({ data: { results: [{ id: '1' }] } })).toHaveLength(1);
  });

  it('returns empty rather than throwing on a shape it does not know', () => {
    expect(extractRecordArray({ ok: true })).toEqual([]);
    expect(extractRecordArray(null)).toEqual([]);
    expect(extractRecordArray('text')).toEqual([]);
  });

  it('ignores arrays of primitives when looking for records', () => {
    // `{tags: ['a','b'], boards: [{...}]}` must not return the tags.
    const out = extractRecordArray({ tags: ['a', 'b'], boards: [{ id: 'b1' }] });
    expect(out).toEqual([{ id: 'b1' }]);
  });
});

describe('toExternalRecords', () => {
  it('reads an id under any of the casings vendors use', () => {
    expect(toExternalRecords([{ ID: 'x' }])[0].id).toBe('x');
    expect(toExternalRecords([{ uuid: 'y' }])[0].id).toBe('y');
  });

  it('falls back to a name when there is no id', () => {
    expect(toExternalRecords([{ name: 'Marketing' }])[0].id).toBe('Marketing');
  });

  it('handles a bare string row', () => {
    expect(toExternalRecords(['PUBLIC'])[0]).toEqual({ id: 'PUBLIC', data: { name: 'PUBLIC' } });
  });
});
