// An observed response path is a declaration the moment it is written.
//
// The observer wrote paths as PENDING proposals for a person to accept, and
// there was nothing left for the person to judge: a path is a fact about a
// response, and what the record at it IS, the read tool's own catalog entry
// already says. So the row lands accepted and typed, the gate reads it on the
// next refresh, and no queue reaches anybody. Accepting can only add to what a
// run has seen, so a path that is noise costs a row and nothing else. The one
// decision a person can still make — reject — stays, and stays made.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  catalogTypeFor: (alias: string) => alias.replace(/-[0-9a-f]{8}$/, '').replace(/-/g, '_'),
}));

const queries: Array<{ text: string; params: unknown[] }> = [];
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (_tenant: string, fn: (_client: { query: (_text: string, _params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) => unknown) =>
    fn({ query: async (text, params) => { queries.push({ text, params }); return { rows: [], rowCount: 1 }; } }),
}));

import { observeReadShape, observedEntityTypesForTenant, pendingShapeCountsForTenant, _resetObservedShapesForTesting } from '../observed-shapes';
import { persistObservedShapes } from '../learned-shapes-store';
import { flushObservedShapes } from '../learned-shapes-flush';

const T = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { _resetObservedShapesForTesting(); queries.length = 0; });

it('the observer keeps the entity the read is declared to return', () => {
  observeReadShape('google_mail.get_thread', { id: 't1', messages: [{ id: 'm1' }] }, T, 'thread');
  expect(observedEntityTypesForTenant(T)).toEqual({ 'google_mail.get_thread': 'thread' });
  expect(Object.keys(pendingShapeCountsForTenant(T)['google_mail.get_thread']).sort()).toEqual(['id', 'messages[].id']);
});

it('persists a path as ACCEPTED, typed, decided by the observer', async () => {
  await persistObservedShapes(T, { 'google_mail.get_thread': { id: 2 } }, { 'google_mail.get_thread': 'thread' });
  expect(queries).toHaveLength(1);
  const { text, params } = queries[0];
  expect(text).toMatch(/'accepted', 'observer'\)/);
  expect(params).toEqual([T, 'google_mail', 'get_thread', 'id', '', 2, 'thread']);
});

it('promotes a row written pending before, and leaves a rejected one rejected', async () => {
  await persistObservedShapes(T, { 'notion-0badf00d.search_pages': { 'results[].id': 1 } });
  const { text } = queries[0];
  // Status moves only from pending; a decision a person made is not undone by
  // seeing the path again.
  expect(text).toMatch(/status\s+= CASE WHEN learned_response_shapes\.status = 'pending' THEN 'accepted'\s+ELSE learned_response_shapes\.status END/);
  // A type it did not have is filled; one it has is kept.
  expect(text).toMatch(/entity_type\s+= COALESCE\(learned_response_shapes\.entity_type, EXCLUDED\.entity_type\)/);
});

it('the flush hands the types along with the counts', async () => {
  observeReadShape('google_mail.get_thread', { id: 't1' }, T, 'thread');
  await flushObservedShapes(T);
  expect(queries[0].params[6]).toBe('thread');
  expect(pendingShapeCountsForTenant(T)).toEqual({});
});
