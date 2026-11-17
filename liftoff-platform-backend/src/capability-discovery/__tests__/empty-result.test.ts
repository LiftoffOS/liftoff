// The one answer to "is there anything here": the shapes a vendor answers a
// miss with, and the shapes that are an answer however small.

import { isEmptyCapabilityResult } from '../empty-result';

describe('isEmptyCapabilityResult', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a blank string', '   \n'],
    ['a bare empty list', []],
    ['a list of empties', [null, '', {}, []]],
    ['{ items: [] }', { items: [] }],
    ['{ results: [] }', { results: [] }],
    ['{ data: [] } with a total', { data: [], total: 0 }],
    ['a vendor wrapper with only metadata around an empty list', { code: 200, message: 'ok', router: '/api/v1/x', params: { q: 'x' }, data: { list: [], total: 0, hasMore: false } }],
    ['metadata alone', { success: true, status: 'ok', count: 0, request_id: 'r-1', took: 12 }],
    ['an empty object', {}],
    ['nested empties', { data: { results: { items: [] } } }],
  ])('%s is empty', (_label, value) => {
    expect(isEmptyCapabilityResult(value)).toBe(true);
  });

  it.each([
    ['a non-blank string', 'hello'],
    ['a number', 42],
    ['a boolean', false],
    ['a list with one record', [{ id: 1 }]],
    ['{ items: [record] }', { items: [{ title: 'x' }] }],
    ['a record with one content field beside metadata', { code: 200, total: 1, data: { list: [{ id: 'a' }] } }],
    ['a scalar answer under a content key', { symbol: 'AAPL', price: 123.4 }],
    ['a single content string inside a wrapper', { status: 'ok', data: { summary: 'Shopify grew 20%' } }],
  ])('%s is content', (_label, value) => {
    expect(isEmptyCapabilityResult(value)).toBe(false);
  });
});
