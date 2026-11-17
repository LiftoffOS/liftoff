// The classify script's request to platform-backend's classifier route: the
// shape it sends, and the property that effect decisions never reach it —
// the route takes names and descriptions and nothing else; decideClass's
// evidence stays on this side.

import {
  buildClassifyRequestBody,
  classifyToolsViaRoute,
  ClassifyRouteRateLimited,
  CLASSIFY_ROUTE_MAX_TOOLS,
} from '../classify-tools-route-client.js';

describe('buildClassifyRequestBody', () => {
  it('sends name and description only, plus the discriminated attribution', () => {
    const body = buildClassifyRequestBody(
      [
        // Fields a script-side tool carries beyond name/description are not
        // in the client's input type; a caller that spreads a richer object
        // in is still narrowed to the two fields.
        { name: 'send_email', description: 'Sends', annotations: { destructiveHint: true }, httpMethod: 'POST', registryCategories: ['write'] } as unknown as { name: string; description: string },
      ],
      { kind: 'global_inventory' },
    );
    expect(body).toEqual({ tools: [{ name: 'send_email', description: 'Sends' }], attribution: { kind: 'global_inventory' } });
    expect(JSON.stringify(body)).not.toMatch(/annotations|httpMethod|registryCategories|destructive|effect/);
  });

  it('carries the tenant when a tenant triggered the classification', () => {
    const body = buildClassifyRequestBody([{ name: 'x', description: '' }], { kind: 'tenant', tenantId: '11111111-1111-4111-8111-111111111111' });
    expect(body.attribution).toEqual({ kind: 'tenant', tenantId: '11111111-1111-4111-8111-111111111111' });
  });
});

describe('classifyToolsViaRoute', () => {
  const ok = (results: unknown) => (async () => new Response(JSON.stringify({ results }), { status: 200 })) as unknown as typeof fetch;

  it('POSTs to /api/internal/tools/classify with the service token and returns the results', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ results: [{ name: 'send_email', categories: ['customerCommunication'], effectClass: 'outbound' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const results = await classifyToolsViaRoute('https://pb.test', 'tok', [{ name: 'send_email', description: 'Sends' }], { kind: 'global_inventory' }, fetchImpl);
    expect(results).toEqual([{ name: 'send_email', categories: ['customerCommunication'], effectClass: 'outbound' }]);
    expect(calls[0].url).toBe('https://pb.test/api/internal/tools/classify');
    expect((calls[0].init.headers as Record<string, string>)['x-service-auth']).toBe('tok');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ tools: [{ name: 'send_email', description: 'Sends' }], attribution: { kind: 'global_inventory' } });
  });

  it('a 429 is the rate-limit signal the script retries on; another error throws', async () => {
    const limited = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await expect(classifyToolsViaRoute('u', 't', [{ name: 'x', description: '' }], { kind: 'global_inventory' }, limited)).rejects.toBeInstanceOf(ClassifyRouteRateLimited);
    const broken = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(classifyToolsViaRoute('u', 't', [{ name: 'x', description: '' }], { kind: 'global_inventory' }, broken)).rejects.toThrow('classify route error 500');
  });

  it('refuses a request over the route bound and sends nothing for an empty list', async () => {
    const never = jest.fn() as unknown as typeof fetch;
    expect(await classifyToolsViaRoute('u', 't', [], { kind: 'global_inventory' }, never)).toEqual([]);
    const over = Array.from({ length: CLASSIFY_ROUTE_MAX_TOOLS + 1 }, (_, i) => ({ name: `t${i}`, description: '' }));
    await expect(classifyToolsViaRoute('u', 't', over, { kind: 'global_inventory' }, never)).rejects.toThrow('at most');
    expect(never).not.toHaveBeenCalled();
    void ok;
  });
});
