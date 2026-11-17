// The window a capability step opens around its turn, and what the handler
// notes into it: typed outcomes, never text.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  _resetCapabilityWindows,
  closeCapabilityWindow,
  noteToolOutcome,
  openCapabilityWindow,
  webResultHasContent,
} from '../capability-outcome-signal';

beforeEach(() => _resetCapabilityWindows());

describe('the capability outcome window', () => {
  it('counts capability runs and web calls, and which of them were useful', () => {
    openCapabilityWindow('inv-1', 'step:s1');
    noteToolOutcome('inv-1', 'run_capability', false);
    noteToolOutcome('inv-1', 'run_capability', true);
    noteToolOutcome('inv-1', 'web_search', false);
    noteToolOutcome('inv-1', 'web_fetch_advanced', true);
    noteToolOutcome('inv-1', 'note_save', true); // not a tool the window counts
    expect(closeCapabilityWindow('inv-1', 'step:s1')).toEqual({
      capabilityRuns: 2, capabilitySuccesses: 1, webRuns: 2, webSuccesses: 1,
    });
  });

  it('drops a note outside any open window, and a note for another invocation', () => {
    noteToolOutcome('inv-1', 'run_capability', true);
    openCapabilityWindow('inv-1', 'step:s1');
    noteToolOutcome('inv-2', 'run_capability', true);
    noteToolOutcome(undefined, 'run_capability', true);
    expect(closeCapabilityWindow('inv-1', 'step:s1')).toEqual({ capabilityRuns: 0, capabilitySuccesses: 0, webRuns: 0, webSuccesses: 0 });
  });

  it('a close naming a window that is not the open one reads zeros and leaves the open one in place', () => {
    openCapabilityWindow('inv-1', 'step:s1');
    noteToolOutcome('inv-1', 'run_capability', true);
    expect(closeCapabilityWindow('inv-1', 'step:s9')).toEqual({ capabilityRuns: 0, capabilitySuccesses: 0, webRuns: 0, webSuccesses: 0 });
    expect(closeCapabilityWindow('inv-1', 'step:s1').capabilitySuccesses).toBe(1);
    // Closed is closed: a second close reads nothing.
    expect(closeCapabilityWindow('inv-1', 'step:s1').capabilitySuccesses).toBe(0);
  });

  it('is keyed by invocation, so two runs\' steps do not share counts', () => {
    openCapabilityWindow('inv-1', 'step:s1');
    openCapabilityWindow('inv-2', 'step:s1');
    noteToolOutcome('inv-1', 'run_capability', true);
    noteToolOutcome('inv-2', 'web_research', true);
    expect(closeCapabilityWindow('inv-1', 'step:s1')).toMatchObject({ capabilitySuccesses: 1, webSuccesses: 0 });
    expect(closeCapabilityWindow('inv-2', 'step:s1')).toMatchObject({ capabilitySuccesses: 0, webSuccesses: 1 });
  });
});

describe('webResultHasContent', () => {
  it.each([
    ['a failure', { success: false, error: 'x' }],
    ['a blank answer', { success: true, result: '   ' }],
    ['an empty list', { success: true, result: [] }],
    ['{ results: [] }', { success: true, result: { results: [] } }],
    ['metadata only', { success: true, result: { query: 'x', total: 0, results: [] } }],
    ['nothing at all', { success: true }],
  ])('%s does not count', (_label, result) => {
    expect(webResultHasContent(result)).toBe(false);
  });

  it.each([
    ['a text answer', { success: true, result: 'Shopify grew 20%' }],
    ['a list of results', { success: true, result: { results: [{ url: 'https://x', title: 't' }] } }],
    ['a fetched page', { success: true, result: { url: 'https://x', content: 'body' } }],
  ])('%s counts', (_label, result) => {
    expect(webResultHasContent(result)).toBe(true);
  });
});
