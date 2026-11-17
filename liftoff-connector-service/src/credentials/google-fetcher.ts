import { logger } from '../infra/logging.js';
import { credentialService, type ConnectorCredentials } from './service.js';
import { tryComposioProxy } from '../clients/composio-transport.js';

export function makeGoogleFetcher(
  tenantId: string,
  connectorId: string,
  initialToken: string,
): (url: string, init?: RequestInit) => Promise<globalThis.Response> {
  let token = initialToken;
  return async (url: string, init?: RequestInit): Promise<globalThis.Response> => {
    const merged: RequestInit = {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    };
    const resp = await fetch(url, merged);
    if (resp.status !== 401) return resp;
    logger.info({ tenantId, connectorId }, 'Google API 401 — force-refreshing token and retrying');
    try {
      const fresh = await credentialService.getCredentials(tenantId, connectorId, { forceRefresh: true });
      if (fresh.accessToken) token = fresh.accessToken;
    } catch (refreshErr) {
      logger.warn(
        { tenantId, connectorId, err: (refreshErr as Error).message },
        'Force-refresh failed — returning original 401',
      );
      return resp;
    }
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    });
  };
}

/**
 * A Google API fetcher that works on either credential transport.
 *
 * Half this service's Google routes opened with
 * `if (!creds.accessToken) return 401` and then built a direct-token fetcher.
 * A composio_managed connector never has an access token — Composio holds the
 * grant and returns "REDACTED" for it — so all of them answered 401 for those
 * tenants: reading a presentation, creating a doc, copy-and-replace, and the
 * job handlers behind them. Six sites, one cause, and each one looked like an
 * expired grant from the outside.
 *
 * Every one of those calls is JSON in and JSON out, which is exactly what
 * Composio's signed proxy carries. So the transport choice belongs here, once,
 * rather than at each call site. The return type is a real Response so callers
 * keep their existing `resp.ok` / `resp.json()` shape and nothing else moves.
 *
 * Binary is the exception and stays the caller's problem: the proxy returns
 * decoded bodies, so downloads and uploads cannot use this.
 */
export function makeGoogleApiFetcher(
  tenantId: string,
  connectorId: string,
  creds: ConnectorCredentials,
): (url: string, init?: RequestInit) => Promise<globalThis.Response> {
  if (creds.flowKind !== 'composio_managed') {
    return makeGoogleFetcher(tenantId, connectorId, creds.accessToken ?? '');
  }

  const proxyCreds = {
    ...creds,
    accessToken: creds.accessToken ?? '',
    tenantId,
    connectorId,
  };

  return async (url: string, init?: RequestInit): Promise<globalThis.Response> => {
    // Composio takes the path and query as separate inputs, so split what the
    // caller assembled into one URL.
    const parsed = new URL(url);
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    let body: unknown;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    try {
      const result = await tryComposioProxy<unknown>(proxyCreds, {
        method: (init?.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        path: `${parsed.origin}${parsed.pathname}`,
        query: Object.keys(query).length > 0 ? query : undefined,
        body,
      });
      if (!result.handled) {
        return new Response(
          JSON.stringify({ error: 'Composio proxy did not handle the request' }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(result.data ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      // composioProxyRequest throws with the vendor status embedded in its
      // message. Recover it so callers keep classifying 404 as "not found"
      // rather than collapsing everything into a 500.
      const message = (err as Error).message ?? 'Composio proxy call failed';
      const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? 502);
      logger.warn({ tenantId, connectorId, url: parsed.pathname, status, err: message }, 'composio google api call failed');
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}
