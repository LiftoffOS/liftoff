// Developer Proxy Client
// Forwards /proxy/* requests to the developer-proxy Cloud Run service.
// When DEVELOPER_PROXY_SERVICE_ENABLED=new, also delegates credential management
// (createCredential, listCredentials, etc.) to developer-proxy's REST API.

import { buildOidcAuthHeader } from '@liftoffos/service-client';

export function getDeveloperProxyUrl(): string {
  const url = process.env.DEVELOPER_PROXY_SERVICE_URL;
  if (!url) throw new Error('DEVELOPER_PROXY_SERVICE_URL is not configured');
  return url.replace(/\/$/, '');
}

export function isDevProxyEnabled(): boolean {
  return process.env.DEVELOPER_PROXY_SERVICE_ENABLED === 'new';
}

async function oidcHeaders(baseUrl: string): Promise<Record<string, string>> {
  try {
    return await buildOidcAuthHeader(baseUrl);
  } catch {
    return {};
  }
}

class DevProxyClientError extends Error {
  statusCode: number;
  devProxyBody: Record<string, unknown>;
  constructor(statusCode: number, body: Record<string, unknown>) {
    super(String(body['error'] ?? 'developer-proxy error'));
    this.statusCode = statusCode;
    this.devProxyBody = body;
  }
}

async function devProxyJson(
  method: string,
  path: string,
  body?: unknown,
  tenantId?: string,
  userId?: string,
): Promise<unknown> {
  const base = getDeveloperProxyUrl();
  // OIDC gates the Cloud Run hop; the shared service token + x-user-id let the
  // developer-proxy trust this as a platform-backend call acting for a user,
  // so its credential routes don't require a browser Firebase JWT.
  const serviceToken = process.env.DEVELOPER_PROXY_SERVICE_TOKEN;
  const headers: Record<string, string> = {
    // Only advertise a JSON body when we actually send one. A bodyless request
    // (e.g. DELETE /credentials/:id for revoke) with Content-Type: application/json
    // makes the proxy's Fastify JSON parser reject it with "Body cannot be empty
    // when content-type is set to 'application/json'" (HTTP 400).
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...await oidcHeaders(base),
    ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    ...(userId ? { 'x-user-id': userId } : {}),
    ...(serviceToken ? { 'x-service-token': serviceToken } : {}),
  };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new DevProxyClientError(res.status, data);
  return data;
}

export type DeveloperProxyVendor = 'anthropic' | 'openai';

// Vendor-neutral credential creation: `vendor` + generic `apiKey`.
// `anthropicApiKey` is preserved for backward compatibility during migration.
export async function createCredential(opts: {
  tenantId: string;
  userId: string;
  vendor?: DeveloperProxyVendor;
  apiKey?: string;
  /** @deprecated use `apiKey` + `vendor` */
  anthropicApiKey?: string;
  label?: string;
}): Promise<Record<string, unknown>> {
  const body = {
    tenantId: opts.tenantId,
    userId: opts.userId,
    vendor: opts.vendor ?? 'anthropic',
    apiKey: opts.apiKey ?? opts.anthropicApiKey,
    label: opts.label,
  };
  return devProxyJson('POST', '/credentials', body, opts.tenantId, opts.userId) as Promise<Record<string, unknown>>;
}

export interface DeveloperProxyCredential {
  id: string;
  tenantId: string;
  userId: string;
  vendor: string;
  keyPrefix: string;
  keyHint: string;
  label: string;
  status: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listCredentials(opts: {
  tenantId: string;
  userId?: string;
  all?: boolean;
}): Promise<DeveloperProxyCredential[]> {
  const q = new URLSearchParams({ tenantId: opts.tenantId });
  if (opts.userId) q.set('userId', opts.userId);
  if (opts.all) q.set('all', 'true');
  const data = await devProxyJson('GET', `/credentials?${q.toString()}`, undefined, opts.tenantId, opts.userId);
  return (data as { credentials: DeveloperProxyCredential[] }).credentials;
}

export async function getCredential(opts: {
  id: string;
  tenantId: string;
  userId: string;
}): Promise<Record<string, unknown> | null> {
  const q = new URLSearchParams({ tenantId: opts.tenantId, userId: opts.userId });
  try {
    return await devProxyJson('GET', `/credentials/${opts.id}?${q.toString()}`, undefined, opts.tenantId, opts.userId) as Record<string, unknown>;
  } catch (e) {
    if ((e as DevProxyClientError).statusCode === 404) return null;
    throw e;
  }
}

export async function getPendingSetupToken(opts: {
  tenantId: string;
  userId: string;
}): Promise<string | null> {
  const q = new URLSearchParams({ tenantId: opts.tenantId, userId: opts.userId });
  try {
    const data = await devProxyJson('GET', `/credentials/pending-setup-token?${q.toString()}`, undefined, opts.tenantId, opts.userId);
    return (data as { setupToken?: string }).setupToken ?? null;
  } catch (e) {
    if ((e as DevProxyClientError).statusCode === 404) return null;
    throw e;
  }
}

export async function revokeCredential(opts: {
  id: string;
  tenantId: string;
  userId: string;
}): Promise<boolean> {
  const q = new URLSearchParams({ tenantId: opts.tenantId, userId: opts.userId });
  try {
    await devProxyJson('DELETE', `/credentials/${opts.id}?${q.toString()}`, undefined, opts.tenantId, opts.userId);
    return true;
  } catch (e) {
    if ((e as DevProxyClientError).statusCode === 404) return false;
    throw e;
  }
}

export async function bindCodeChallenge(opts: {
  setupToken: string;
  codeChallenge: string;
  tenantId: string;
  userId: string;
}): Promise<boolean> {
  try {
    await devProxyJson('POST', '/credentials/pkce-bind', opts, opts.tenantId, opts.userId);
    return true;
  } catch (e) {
    if ((e as DevProxyClientError).statusCode === 404) return false;
    throw e;
  }
}

export async function exchangeSetupToken(opts: {
  setupToken: string;
  userId: string;
  codeVerifier: string;
  tenantId: string;
}): Promise<{ fullKey: string; proxyBaseUrl: string } | null> {
  try {
    return await devProxyJson('POST', '/credentials/setup-exchange', opts, opts.tenantId) as { fullKey: string; proxyBaseUrl: string };
  } catch (e) {
    if ((e as DevProxyClientError).statusCode === 404) return null;
    throw e;
  }
}

export async function pipeToDeveloperProxy(
  method: string,
  path: string,
  incomingHeaders: Record<string, string | string[] | undefined>,
  body: Buffer | undefined,
): Promise<globalThis.Response> {
  const base = getDeveloperProxyUrl();
  const url = `${base}${path}`;

  const forwardHeaders: Record<string, string> = {};
  // `authorization` MUST be forwarded: Codex/OpenAI presents its liftoff_sk_ key
  // via `Authorization: Bearer` (Anthropic uses `x-api-key`). The proxy's auth
  // layer reads either.
  const allowed = ['authorization', 'x-api-key', 'content-type', 'anthropic-version', 'anthropic-beta', 'x-claude-code-session-id'];
  for (const key of allowed) {
    const val = incomingHeaders[key];
    if (typeof val === 'string') forwardHeaders[key] = val;
  }
  // Cloud Run IAM: send the OIDC token via X-Serverless-Authorization so it does
  // NOT clobber the client's Authorization (the liftoff_sk_ key). Cloud Run
  // consumes X-Serverless-Authorization for IAM and passes Authorization through.
  const oidc = await oidcHeaders(base);
  if (oidc.Authorization) forwardHeaders['X-Serverless-Authorization'] = oidc.Authorization;

  return fetch(url, {
    method,
    headers: forwardHeaders,
    body: body?.length ? Uint8Array.from(body) : undefined,
  });
}
