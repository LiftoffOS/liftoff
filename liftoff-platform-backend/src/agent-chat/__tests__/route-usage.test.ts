// The routing request's usage row, finalised FROM THE ANSWER: a confident
// choice writes one route_message row with the team's id (customer usage);
// none, sub-threshold and a failed call each write one route_message_none row
// (platform overhead); never two rows for one call.

jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../infrastructure/secrets', () => ({ getTypeSafeApiKey: jest.fn().mockResolvedValue('key') }));
const recordMock = jest.fn().mockResolvedValue(true);
jest.mock('../../typesafe/usage', () => ({ recordTypeSafeUsage: (...a: unknown[]) => recordMock(...a) }));

import { _setTypeSafeClientFactoryForTesting } from '../../typesafe/client';
import { suggestAnswerer } from '../route-suggestion';
import { routeMessageSet, TYPESAFE_MODEL } from '../../typesafe/questions';
import { classifyChargeability } from '../../cost-attribution/event-classification';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const candidates = [{ id: A, role: 'Code Reviewer', summary: 'Reviews pull requests' }, { id: B, role: 'Sales Ops', summary: 'Invoices' }];
const ROUTE_T = routeMessageSet(candidates).thresholds.ROUTE_T as number;

function client(answer: { choice: string; probabilities: Record<string, number> } | Error) {
  const systemOne = jest.fn(() => {
    const p = answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ model: TYPESAFE_MODEL, usage: { input_tokens: 100, output_tokens: 0 }, answers: { answerer: { type: 'choice', confidence: 1, ...answer } } });
    return Object.assign(p, { withResponse: () => p.then((data) => ({ data, response: {}, requestId: 'req' })) });
  });
  return { systemOne } as unknown as import('@typesafe-ai/sdk').TypeSafeClient;
}

beforeEach(() => { jest.clearAllMocks(); delete process.env.TYPESAFE_ROUTING_ENABLED; });
afterEach(() => _setTypeSafeClientFactoryForTesting(null));

const input = { tenantId: 't1', message: 'can you review PR 412', channel: { kind: 'dm' as const }, candidates, surface: 'slack' as const };

describe('route usage', () => {
  it('a confident choice → one route_message row with the team id, classified as customer', async () => {
    _setTypeSafeClientFactoryForTesting(() => client({ choice: A, probabilities: { [A]: 0.9, [B]: 0.08, none: 0.02 } }));
    const r = await suggestAnswerer(input);
    expect(r).toEqual({ agentId: A, probability: 0.9 });
    expect(recordMock).toHaveBeenCalledTimes(1);
    const row = recordMock.mock.calls[0][0];
    expect(row.context).toEqual(expect.objectContaining({ purpose: 'route_message', agentId: A, tenantId: 't1' }));
    expect(classifyChargeability({ source: 'platform_llm', purpose: row.context.purpose, agentId: A })).toBe('customer');
  });

  it('none → one route_message_none row, overhead', async () => {
    _setTypeSafeClientFactoryForTesting(() => client({ choice: 'none', probabilities: { [A]: 0.1, [B]: 0.1, none: 0.8 } }));
    expect(await suggestAnswerer(input)).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const row = recordMock.mock.calls[0][0];
    expect(row.context.purpose).toBe('route_message_none');
    expect(row.context.agentId).toBeUndefined();
    expect(classifyChargeability({ source: 'platform_llm', purpose: 'route_message_none', agentId: null })).toBe('platform_overhead');
  });

  it('a sub-threshold choice → route_message_none', async () => {
    _setTypeSafeClientFactoryForTesting(() => client({ choice: A, probabilities: { [A]: ROUTE_T - 0.05, [B]: 0.3, none: 0.75 - ROUTE_T } }));
    expect(await suggestAnswerer(input)).toBeNull();
    expect(recordMock.mock.calls[0][0].context.purpose).toBe('route_message_none');
  });

  it('a failed call → one route_message_none row', async () => {
    const { APIError } = jest.requireActual('@typesafe-ai/sdk');
    _setTypeSafeClientFactoryForTesting(() => client(APIError.fromResponse(503, {}, new Headers())));
    expect(await suggestAnswerer(input)).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][0]).toEqual(expect.objectContaining({ outcome: 'no_response', context: expect.objectContaining({ purpose: 'route_message_none' }) }));
  });

  it('the kill, an empty roster and a roster over the cap make no call', async () => {
    const c = client({ choice: A, probabilities: { [A]: 1, [B]: 0, none: 0 } });
    _setTypeSafeClientFactoryForTesting(() => c);
    process.env.TYPESAFE_ROUTING_ENABLED = '0';
    expect(await suggestAnswerer(input)).toBeNull();
    delete process.env.TYPESAFE_ROUTING_ENABLED;
    expect(await suggestAnswerer({ ...input, candidates: [] })).toBeNull();
    const over = Array.from({ length: 255 }, (_, i) => ({ id: `id-${i}`, role: 'r', summary: 's' }));
    expect(await suggestAnswerer({ ...input, candidates: over })).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });
});
