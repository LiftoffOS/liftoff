// Building one request to a custom API: the recorded placement applied, the
// destination checked against the hosts the person consented to, and a
// loggable form of the URL that never carries the credential.
//
// This is the authorization concern, and it lives here rather than in the
// executor so the VERIFICATION call goes through exactly the same code. A
// verification that reached the vendor a different way would prove something
// other than what the executor does.

import { appendBracketed } from './body.js';
import type { QueryValue } from '../clients/templated-dispatch.js';
import { hostAllowed } from './spec.js';
import type { CustomApiAuthPlacement } from './types.js';

/** Refused before anything left the process. */
export class BlockedHostError extends Error {
  readonly host: string;
  constructor(host: string, allowed: readonly string[]) {
    super(
      `blocked_host: this connection may reach ${allowed.join(', ')} and the request was for ${host}`,
    );
    this.name = 'BlockedHostError';
    this.host = host;
  }
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  /** What to write down. Query-parameter and path-segment placements put the
   *  credential IN the URL, so the recorded form is never `url`. */
  loggableUrl: string;
}

/**
 * Apply the recorded placement to a request.
 *
 * `path` is relative to `baseUrl` and already has its own path parameters
 * filled in. `query` is whatever the operation asked for; the credential's own
 * parameter is added here and nowhere else.
 */
export function buildCustomApiRequest(args: {
  baseUrl: string;
  path: string;
  query?: Record<string, QueryValue>;
  /** Query parameters the specification declared `deepObject`, which are
   *  written bracketed rather than repeated. */
  deepObjectParams?: readonly string[];
  /** Query arrays written as one comma-joined value (`explode: false`). */
  joinedArrayParams?: readonly string[];
  /** Headers the OPERATION declared, already filtered to the ones the
   *  specification offered. Applied before anything the connection owns, so
   *  the credential and the body's own encoding always win. */
  operationHeaders?: Record<string, string>;
  apiHosts: readonly string[];
  placement: CustomApiAuthPlacement;
  credential: string;
}): BuiltRequest {
  const { baseUrl, path, query, apiHosts, placement, credential, operationHeaders, deepObjectParams, joinedArrayParams } = args;

  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  let relative = path.startsWith('/') ? path : `/${path}`;

  // A path-segment placement fills a named placeholder in the operation's own
  // path. Done before the URL is parsed so the credential is encoded like any
  // other segment.
  let pathCarriedCredential = false;
  if (placement.scheme === 'path' && placement.name) {
    const token = `{${placement.name}}`;
    if (relative.includes(token)) {
      relative = relative.split(token).join(encodeURIComponent(credential));
      pathCarriedCredential = true;
    }
  }

  let url: URL;
  try {
    url = new URL(`${base}${relative}`);
  } catch {
    throw new Error(`custom_api: "${base}${relative}" is not a URL that can be built`);
  }

  // The host check. The executor is where this family's egress control lives:
  // the tenant runtime's exact-URL MCP allow-list governs MCP endpoints and is
  // untouched by this connector, so the recorded `api_hosts` is the whole of
  // the answer to "where may this connection reach".
  if (!hostAllowed(url.host, apiHosts)) {
    throw new BlockedHostError(url.host, apiHosts);
  }
  // A plaintext destination would put a header credential on the wire in the
  // clear, and a query-parameter one in a URL anybody on the path can read.
  if (url.protocol !== 'https:') {
    throw new BlockedHostError(`${url.protocol}//${url.host}`, apiHosts);
  }

  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    // A `deepObject` parameter is written bracketed — `created[gte]=1`, and an
    // array indexed as `expand[0]=customer`. Providers declare the style
    // precisely because the default has no way to say what they mean.
    if (deepObjectParams?.includes(k)) {
      appendBracketed(url.searchParams, k, v, { indexArrays: true });
      continue;
    }
    // `explode: false` is the other half of `form`: one value with the
    // elements joined, which is a different request from the repeated one and
    // the one Asana asks for on `opt_fields`.
    if (Array.isArray(v) && joinedArrayParams?.includes(k)) {
      url.searchParams.set(k, v.map((item) => String(item)).join(','));
      continue;
    }
    // A list is the parameter REPEATED, which is what `form` with explode
    // means and what OpenAPI defaults a query array to. `set` with a joined
    // string is a different request: one value with a comma in it.
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        url.searchParams.append(k, String(item));
      }
      continue;
    }
    if (typeof v === 'object') {
      // Structured, but the operation never said how the provider wants it.
      // Bracketing is the common reading and the one every deepObject
      // provider uses, so it is what an undeclared structure gets rather than
      // the words "[object Object]".
      appendBracketed(url.searchParams, k, v, { indexArrays: false });
      continue;
    }
    url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  // The operation's own headers go on FIRST. What follows is the connection's
  // — the credential, and whatever the body's encoding requires — so a
  // declared header can never displace the key or contradict how we wrote the
  // payload. The subset check has already refused the transport headers and
  // the one the credential lives in; this ordering is what makes that refusal
  // the only thing standing between them.
  for (const [rawName, value] of Object.entries(operationHeaders ?? {})) {
    if (value === undefined || value === null) continue;
    headers[rawName.toLowerCase()] = String(value);
  }
  let queryCarriedCredential = false;
  switch (placement.scheme) {
    case 'bearer_header':
      headers.authorization = `Bearer ${credential}`;
      break;
    case 'header':
      if (placement.name) headers[placement.name.toLowerCase()] = `${placement.prefix ?? ''}${credential}`;
      break;
    case 'query':
      if (placement.name) {
        url.searchParams.set(placement.name, credential);
        queryCarriedCredential = true;
      }
      break;
    case 'path':
      // Already substituted above. Nothing on the headers or the query.
      break;
  }

  return {
    url: url.toString(),
    headers,
    loggableUrl: redactedUrl(url, placement, {
      query: queryCarriedCredential,
      path: pathCarriedCredential,
      credential,
    }),
  };
}

/**
 * The URL with the credential taken out of it.
 *
 * Used wherever a request is recorded — a log line, an error message, an audit
 * row. The two placements that put the value in the URL are exactly the two
 * this redacts; a header placement never reaches it.
 */
export function redactedUrl(
  url: URL,
  placement: CustomApiAuthPlacement,
  carried: { query: boolean; path: boolean; credential: string },
): string {
  const copy = new URL(url.toString());
  if (carried.query && placement.name) copy.searchParams.set(placement.name, '[REDACTED]');
  let out = copy.toString();
  if (carried.path && carried.credential) {
    // The segment was encoded on the way in, so both forms are replaced: the
    // encoded one is what is actually in the URL, and the raw one is what a
    // credential with no reserved characters looks like.
    out = out.split(encodeURIComponent(carried.credential)).join('[REDACTED]');
    out = out.split(carried.credential).join('[REDACTED]');
  }
  return out;
}
