// Regression: IntercomNormalizer must handle Intercom's null fields.
//
// Intercom's GET /conversations returns source:null (and null user_id/admin_id)
// on API-created conversations. The normalizer's Zod schemas use .optional()
// (accepts undefined, NOT null), so without coalescing nulls→undefined it throws
// on real data. Shape below is from a live dev account.

import { IntercomNormalizer } from './intercom.js';

describe('IntercomNormalizer null handling', () => {
  const norm = new IntercomNormalizer();

  it('normalizes a real conversation with source:null + tag.list object without throwing', () => {
    // Exact shape from a live Intercom GET /conversations: source null, title null,
    // tags as a { type:'tag.list', tags:[] } object (not a flat array).
    const realConv = {
      type: 'conversation', id: '215474880214115', created_at: 1782678291, updated_at: 1782678293,
      source: null, title: null, state: 'open', open: true, read: false, priority: 'not_priority',
      admin_assignee_id: 10960611, tags: { type: 'tag.list', tags: [] },
      contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: '6a418311c780a8e3dfac46c7' }] },
    };
    const out = norm.normalize({ results: [realConv] });
    expect(out).toHaveLength(1);
    expect(out[0].entityType).toBe('Conversation');
    expect(out[0].externalId).toBe('215474880214115');
  });

  it('extracts tag names from a tag.list object', () => {
    const conv = {
      type: 'conversation', id: '7', created_at: 1, updated_at: 2, source: null,
      tags: { type: 'tag.list', tags: [{ id: '1', name: 'vip' }, { id: '2', name: 'billing' }] },
    };
    const out = norm.normalize({ results: [conv] });
    expect((out[0].data as { tags?: string[] }).tags).toEqual(['vip', 'billing']);
  });

  it('coalesces null user_id/admin_id on a conversation', () => {
    const conv = {
      type: 'conversation', id: '9', created_at: 1, updated_at: 2,
      source: null, user_id: null, admin_id: null,
    };
    expect(() => norm.normalize({ results: [conv] })).not.toThrow();
  });
});
