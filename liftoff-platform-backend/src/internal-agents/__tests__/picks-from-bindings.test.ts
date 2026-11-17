// templatePicks is an input to distillation, not a stored field, so a
// redistill had nothing to resolve a template's {{pick:...}} against and fell
// through to the generic fallback: an agent told to post to "#deal-room"
// starts saying "your deal channel".

import { templatePicksFromBindings } from '../picks-from-bindings';

// Shaped like a stored binding.
const LIVE = [{
  id: '8fd9fc68-531e-4443-91ae-642c19077518',
  integrationId: 'google_docs',
  config: {
    destinations: {
      'working-folder': {
        id: '1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I',
        ref: 'id',
        kind: 'file',
        name: 'Acme competition test',
      },
    },
  },
}];

describe('templatePicksFromBindings', () => {
  it('recovers the pick a redistill would otherwise lose', () => {
    expect(templatePicksFromBindings(LIVE)).toEqual({
      'working-folder': {
        id: '1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I',
        title: 'Acme competition test',
        kind: 'file',
      },
    });
  });

  it('carries kind only for a destination, where it changes the sentence', () => {
    const channel = [{ config: { destinations: { 'alert-channel': { id: 'C1', name: '#alerts', kind: 'channel' } } } }];
    expect(templatePicksFromBindings(channel)['alert-channel']).toEqual({ id: 'C1', title: '#alerts' });
  });

  it('accepts folder as well as file', () => {
    const folder = [{ config: { destinations: { d: { id: 'F1', name: 'Weekly', kind: 'folder' } } } }];
    expect(templatePicksFromBindings(folder).d.kind).toBe('folder');
  });

  it('skips a destination with no name, rather than rendering an empty one', () => {
    // "Post the summary to " is worse than the fallback phrase it replaced.
    expect(templatePicksFromBindings([{ config: { destinations: { d: { id: 'X' } } } }])).toEqual({});
  });

  it('reads every binding, not just the first', () => {
    const two = [
      { config: { destinations: { 'working-folder': { id: '1', name: 'Docs' } } } },
      { config: { destinations: { 'alert-channel': { id: '2', name: '#ops' } } } },
    ];
    expect(Object.keys(templatePicksFromBindings(two)).sort()).toEqual(['alert-channel', 'working-folder']);
  });

  it.each([
    ['no integrations', undefined],
    ['an empty list', []],
    ['a binding with no config', [{ id: 'x' }]],
    ['a null config', [{ config: null }]],
    ['a config with no destinations', [{ config: { gmailQuery: 'is:unread' } }]],
  ])('returns nothing for %s', (_label, input) => {
    expect(templatePicksFromBindings(input as unknown[])).toEqual({});
  });
});
