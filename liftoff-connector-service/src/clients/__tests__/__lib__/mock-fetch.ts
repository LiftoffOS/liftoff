// Shared fetch mock for native HRIS client tests. Records every outgoing call
// (url / method / parsed body) and replays a responder's queued responses. Extracted
// verbatim from native-hris-clients.test.ts so the request-conformance suite can reuse it.
import type { ConnectorCredentials } from '../../types.js';

export interface Call { url: string; method: string; body?: unknown }

/** Install a fetch mock that replays queued responses and records every call. */
export function mockFetch(responder: (call: Call) => { status?: number; json?: unknown; text?: string }): Call[] {
  const calls: Call[] = [];
  const parseBody = (b?: string): unknown => {
    if (!b) return undefined;
    try { return JSON.parse(b); } catch { return b; } // form-encoded token bodies aren't JSON
  };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = { url, method: init?.method ?? 'GET', body: parseBody(init?.body) };
    calls.push(call);
    const r = responder(call);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  });
  return calls;
}

export const provider = (creds: Partial<ConnectorCredentials>) => async () =>
  ({ accessToken: 'tok', ...creds } as ConnectorCredentials);
