// Gloria native executor: the free tools' streamable-HTTP MCP handshake and
// result mapping, and the premium tools' REST lane (Elite bearer first, x402
// second — probed live: premium is gated on the REST endpoints,
// NOT on the MCP tool call). Both transports are mocked — no network, no
// payments.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

const PAID_HEADER = 'x-x402-paid-usd';
const TX_HEADER = 'x-x402-transaction';

// What the fakes capture and how they answer.
let capturedHeaders: Record<string, string> = {};
let x402Calls: Array<{ url: string; query?: Record<string, string>; declaredPriceUsd?: number }> = [];
let bearerRestCalls: Array<{ url: string; query?: Record<string, string>; auth?: string }> = [];
const toolCallResult = { current: '{"code":"ai","name":"AI"}' };
const toolCallIsError = { current: false };
const premiumBody = { current: { summary: 'up only' } as unknown };
const premiumPaidUsd = { current: 0.031 as number | null };
const bearerAnswer = { current: 402 as number };

function sse(id: number, obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: obj })}`;
}
function resp(status: number, body: unknown, headers: Record<string, string> = {}, asText = false): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
    text: async () => (asText ? String(body) : JSON.stringify(body)),
    json: async () => (asText ? JSON.parse(String(body)) : body),
  } as unknown as Response;
}

function mcpHandshake(req: { body?: { method?: string } }): Response {
  const method = req.body?.method;
  if (method === 'initialize') return resp(200, sse(1, { protocolVersion: '2025-06-18' }), { 'mcp-session-id': 'sess-1' }, true);
  if (method === 'notifications/initialized') return resp(202, '', {}, true);
  const content = [{ type: 'text', text: toolCallResult.current }];
  return resp(200, sse(2, { content, isError: toolCallIsError.current }), {}, true);
}

jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'Mozilla/5.0' },
  X402_PAID_USD_HEADER: 'x-x402-paid-usd',
  X402_TRANSACTION_HEADER: 'x-x402-transaction',
  readX402Receipt: (r: Response) => {
    const paid = r.headers.get('x-x402-paid-usd');
    if (paid === null) return undefined;
    const amountUsd = Number(paid);
    if (!Number.isFinite(amountUsd)) return undefined;
    return { amountUsd, transaction: r.headers.get('x-x402-transaction') ?? undefined };
  },
  makePublicWebTransport: (_type: string, headers: Record<string, string>) => {
    capturedHeaders = headers;
    return async (req: { url: string; query?: Record<string, string>; body?: { method?: string } }) => {
      if (req.url.includes('api.itsgloria.ai')) {
        // The premium REST lane on a tenant's Elite bearer.
        bearerRestCalls.push({ url: req.url, query: req.query, auth: headers.Authorization });
        if (bearerAnswer.current === 402) return resp(402, { error: 'X-PAYMENT header is required' });
        return resp(bearerAnswer.current, premiumBody.current);
      }
      return mcpHandshake(req);
    };
  },
  makeX402Transport: (_type: string, opts?: { declaredPriceUsd?: number }) => {
    return async (req: { url: string; query?: Record<string, string> }) => {
      x402Calls.push({ url: req.url, query: req.query, declaredPriceUsd: opts?.declaredPriceUsd });
      const headers: Record<string, string> = premiumPaidUsd.current !== null
        ? { [PAID_HEADER]: premiumPaidUsd.current.toFixed(6), [TX_HEADER]: '0xabc' }
        : {};
      return resp(200, premiumBody.current, headers);
    };
  },
}));

import { gloriaExecutor } from './gloria-mcp.js';

function ctx(overrides: Partial<ExecutorContext>): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: 'internal:gloria', connectorType: 'gloria',
    connectorConfig: {}, functionName: 'get_categories', input: {},
    idempotencyKey: 'i', traceId: 'tr', credentials: { flowKind: 'api_key' }, ...overrides,
  };
}

beforeEach(() => {
  capturedHeaders = {};
  x402Calls = [];
  bearerRestCalls = [];
  toolCallResult.current = '{"code":"ai","name":"AI"}';
  toolCallIsError.current = false;
  premiumBody.current = { summary: 'up only' };
  premiumPaidUsd.current = 0.031;
  bearerAnswer.current = 402;
});

describe('gloria free tools (MCP)', () => {
  it('runs the handshake and maps the JSON text result into items', async () => {
    const out = await gloriaExecutor(ctx({ functionName: 'get_categories' }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
    // Free lane: nothing was funded per-call, so the wire stays unreported.
    expect(out.fundingSource).toBeUndefined();
    expect((out.result as { items: Array<{ code: string }> }).items[0].code).toBe('ai');
  });

  it('sends NO Authorization for the platform (no BYO) path', async () => {
    await gloriaExecutor(ctx({ functionName: 'get_categories' }));
    expect(capturedHeaders.Authorization).toBeUndefined();
  });

  it('rides the tenant BYO key as the MCP bearer when provided', async () => {
    await gloriaExecutor(ctx({ credentials: { flowKind: 'api_key', apiKey: 'tenant-key' } }));
    expect(capturedHeaders.Authorization).toBe('Bearer tenant-key');
  });

  it('treats an isError tool result as a typed failure', async () => {
    toolCallResult.current = 'rate limited';
    toolCallIsError.current = true;
    const out = await gloriaExecutor(ctx({ functionName: 'search_news', input: { query: 'x' } }));
    expect(out.failure?.message).toContain('rate limited');
  });

  it('refuses a tool gloria does not have', async () => {
    const out = await gloriaExecutor(ctx({ functionName: 'not_a_tool' }));
    expect(out.failure?.message).toContain('no tool named');
  });
});

describe('gloria premium tools (REST, Elite bearer → x402)', () => {
  it('pays the REST endpoint via x402 and books the receipt as costUsd (no BYO key)', async () => {
    const out = await gloriaExecutor(ctx({ functionName: 'get_ticker_summary', input: { ticker: 'BTC' } }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.031, 9);
    expect(out.fundingSource).toBe('x402_wallet');
    expect(bearerRestCalls).toHaveLength(0);
    expect(x402Calls).toHaveLength(1);
    expect(x402Calls[0].url).toBe('https://api.itsgloria.ai/news-ticker-summary');
    expect(x402Calls[0].query).toEqual({ ticker: 'BTC' });
    expect(x402Calls[0].declaredPriceUsd).toBe(0.031);
    expect(out.result).toEqual({ summary: 'up only' });
  });

  it('serves get_enriched_news off its own endpoint with the declared price', async () => {
    premiumPaidUsd.current = 0.03;
    await gloriaExecutor(ctx({ functionName: 'get_enriched_news', input: { feed_categories: 'bitcoin', limit: 5 } }));
    expect(x402Calls[0].url).toBe('https://api.itsgloria.ai/news');
    expect(x402Calls[0].query).toEqual({ feed_categories: 'bitcoin', limit: '5' });
    expect(x402Calls[0].declaredPriceUsd).toBe(0.03);
  });

  it("serves premium on the tenant's own Elite bearer at costUsd 0, never touching x402", async () => {
    bearerAnswer.current = 200;
    // A tenant's own key only ever arrives on a real connector instance —
    // the `internal:` path carries the platform's credential instead.
    const out = await gloriaExecutor(ctx({
      connectorId: 'conn-gloria-tenant-1',
      functionName: 'get_ticker_summary',
      input: { ticker: 'SOL' },
      credentials: { flowKind: 'api_key', apiKey: 'elite-key' },
    }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
    expect(out.fundingSource).toBe('tenant_key');
    expect(bearerRestCalls).toHaveLength(1);
    expect(bearerRestCalls[0].auth).toBe('Bearer elite-key');
    expect(x402Calls).toHaveLength(0);
  });

  it("labels a bearer riding the internal path as the PLATFORM's money", async () => {
    bearerAnswer.current = 200;
    // On `internal:gloria` the dispatcher rides the platform key inside
    // credentials; the stamp must not read that as the tenant's.
    const out = await gloriaExecutor(ctx({
      functionName: 'get_ticker_summary',
      input: { ticker: 'SOL' },
      credentials: { flowKind: 'api_key', apiKey: 'platform-elite-key' },
    }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
    expect(out.fundingSource).toBe('platform_key');
  });

  it('falls through to x402 when the bearer is not Elite-entitled (402)', async () => {
    bearerAnswer.current = 402;
    const out = await gloriaExecutor(ctx({
      functionName: 'get_ticker_summary',
      input: { ticker: 'SOL' },
      credentials: { flowKind: 'api_key', apiKey: 'basic-key' },
    }));
    expect(out.failure).toBeUndefined();
    expect(bearerRestCalls).toHaveLength(1);
    expect(x402Calls).toHaveLength(1);
    expect(out.costUsd).toBeCloseTo(0.031, 9);
    // The wallet paid in the end, whatever bearer was tried first.
    expect(out.fundingSource).toBe('x402_wallet');
  });

  it('books costUsd 0 for a premium response that carried no receipt', async () => {
    premiumPaidUsd.current = null;
    const out = await gloriaExecutor(ctx({ functionName: 'get_enriched_news', input: { feed_categories: 'ai' } }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
  });
});
