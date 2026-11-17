// The declared verification call — the step that stops "connected" meaning
// "verified".
//
// Our own custom-MCP path has the opposite behaviour today: a failed discovery
// leaves the row `active` with no tools, which is how a Help Center server sat
// healthy on the page for three months while every call 401'd.
//
// The reason NAMES THE LAYER. A 401 is not proof the person typed the key
// wrong: placement, host, environment and scope come first, and a message that
// says "authentication" rather than "bad key" is what makes the next question
// the right one.

import { logger } from '../infra/logging.js';
import { BlockedHostError, buildCustomApiRequest } from './request.js';
import type {
  CustomApiAuthPlacement,
  CustomApiVerification,
  CustomApiVerificationOutcome,
} from './types.js';

const VERIFY_TIMEOUT_MS = 15_000;

/** Read a dotted path out of a JSON body, e.g. `data.account.email`. */
export function readIdentityField(body: unknown, field: string): string | null {
  let node: unknown = body;
  for (const segment of field.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node === 'string' && node.trim() !== '') return node.trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  return null;
}

/** Which layer answered, for an HTTP status. */
function layerFor(status: number): NonNullable<CustomApiVerificationOutcome['layer']> {
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'endpoint';
  if (status === 429) return 'rate_limit';
  return 'unreachable';
}

function messageFor(
  layer: NonNullable<CustomApiVerificationOutcome['layer']>,
  loggableUrl: string,
): string {
  switch (layer) {
    case 'authentication':
      return `The provider refused the credential at ${loggableUrl} (401). That is not proof the key is wrong: the same answer comes back when the key belongs to another environment, when it lacks the scope this endpoint needs, or when it was placed somewhere the provider does not read.`;
    case 'permission':
      return `The credential was accepted and this endpoint was refused at ${loggableUrl} (403). The key is valid and does not carry the permission this call needs.`;
    case 'endpoint':
      return `The verification endpoint ${loggableUrl} does not exist at the provider (404). The credential was not tested, because there was nothing to test it against.`;
    case 'rate_limit':
      return `The provider is rate limiting this connection (429), so the credential could not be tested yet.`;
    case 'blocked_host':
      return `The verification call was for a host this connection was not described with, so nothing was sent.`;
    case 'unreachable':
    default:
      return `The provider could not be reached at ${loggableUrl}.`;
  }
}

/**
 * Run the declared verification call.
 *
 * GET or HEAD only — the type says so and this asserts it, because a
 * verification that could change something at the provider is not a
 * verification.
 */
export async function runVerification(args: {
  baseUrl: string;
  apiHosts: readonly string[];
  placement: CustomApiAuthPlacement;
  verification: CustomApiVerification;
  credential: string;
}): Promise<CustomApiVerificationOutcome> {
  const { baseUrl, apiHosts, placement, verification, credential } = args;
  const method = verification.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      ok: false,
      layer: 'endpoint',
      message: 'A verification call is a read: only GET and HEAD are accepted for it.',
    };
  }

  let built;
  try {
    built = buildCustomApiRequest({
      baseUrl,
      path: verification.path,
      query: verification.query,
      apiHosts,
      placement,
      credential,
    });
  } catch (err) {
    if (err instanceof BlockedHostError) {
      return { ok: false, layer: 'blocked_host', message: messageFor('blocked_host', '') };
    }
    return { ok: false, layer: 'unreachable', message: (err as Error).message };
  }

  let response: Response;
  try {
    response = await fetch(built.url, {
      method,
      headers: built.headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    // The loggable URL, never `built.url`: a query-parameter or path-segment
    // placement puts the credential in the URL, and an error message is a
    // place a request gets recorded.
    logger.warn(
      { url: built.loggableUrl, err: (err as Error).message },
      'custom_api_verification_unreachable',
    );
    return {
      ok: false,
      layer: 'unreachable',
      message: messageFor('unreachable', built.loggableUrl),
    };
  }

  if (!response.ok) {
    const layer = layerFor(response.status);
    return {
      ok: false,
      layer,
      httpStatus: response.status,
      message: messageFor(layer, built.loggableUrl),
    };
  }

  // Account identity is OPTIONAL and DECLARED. Where the provider exposes one,
  // the specification names the field and we record it as the connection's
  // external-account label — which is what makes handing the capture link to a
  // colleague safe, because a key for someone's personal account shows on the
  // connection rather than quietly working. Where it is absent, the flow does
  // not depend on it.
  let externalAccountLabel: string | undefined;
  if (verification.accountIdentityField && method === 'GET') {
    try {
      const body = await response.json();
      externalAccountLabel = readIdentityField(body, verification.accountIdentityField) ?? undefined;
    } catch {
      // A provider that verified cleanly and returned something we could not
      // read is verified. The label is a nicety; the call is the proof.
      externalAccountLabel = undefined;
    }
  }

  return { ok: true, httpStatus: response.status, ...(externalAccountLabel ? { externalAccountLabel } : {}) };
}
