// Turning a customer's Vertex service account into a bearer the gateway can send.
//
// THIS IS WHAT MAKES ACCESS PERPETUAL, and it is worth being explicit because
// the hour on the token invites the opposite conclusion. What the customer gives
// us is a service account: a key pair that does not expire. What goes on the
// wire is an OAuth access token minted from it, which lasts about an hour. The
// key is the durable half and it stays in Secret Manager; the token is a
// disposable derivative that is re-minted on demand, forever, exactly the way
// every Google SDK does it.
//
// So a workspace's teams keep running indefinitely. The only things that end
// access are the customer deleting or disabling the key in their own IAM, or
// removing the service account's Vertex role — and both of those surface here
// as a failed exchange, which the gateway turns into `status = 'revoked'` on the
// card.
//
// The JWT client is cached per credential because it does the refresh itself:
// google-auth-library holds the last token and re-exchanges it shortly before
// expiry. Constructing one per request would mint a fresh token per call, which
// is a signing operation and a round trip to Google's token endpoint on the hot
// path of every LLM request.

import { JWT } from 'google-auth-library';
import { createHash } from 'crypto';
import type { VertexServiceAccountCredential } from '../tenant-ai-provider-keys/types';

/** The scope Vertex prediction requires. Nothing narrower exists for it. */
const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Cached JWT clients, keyed by the credential's own content.
 *
 * Keyed by a hash of the material rather than by the secret name so a ROTATED
 * service account cannot be served from the cache: a new key produces a new
 * cache key, and the stale client is simply never asked again. Keying by name
 * would have kept minting tokens from the previous key until the process
 * recycled.
 */
const clients = new Map<string, JWT>();

/** Bounded so a long-lived instance serving many tenants cannot accumulate one
 *  client per credential it has ever seen. Evicting the oldest is safe: the next
 *  request for it simply rebuilds one. */
const MAX_CACHED_CLIENTS = 500;

// There is deliberately NO invalidation hook, and the content-addressed key
// above is why. A rotated service account hashes differently, so it gets a new
// client and the old one is simply never asked for again — the stale-credential
// bug an invalidation hook would exist to prevent cannot occur. A revoked one is
// refused by the resolver before it reaches here, so its client also goes idle.
// Both are evicted in turn by the bound. An `invalidate()` that nothing needed
// to call would be a lever suggesting a hazard that is not there.

function cacheKey(credential: VertexServiceAccountCredential): string {
  return createHash('sha256')
    .update(`${credential.clientEmail}\n${credential.privateKey}`)
    .digest('hex');
}

function clientFor(credential: VertexServiceAccountCredential): JWT {
  const key = cacheKey(credential);
  const existing = clients.get(key);
  if (existing) return existing;

  const client = new JWT({
    email: credential.clientEmail,
    key: credential.privateKey,
    scopes: VERTEX_SCOPES,
  });

  if (clients.size >= MAX_CACHED_CLIENTS) {
    const oldest = clients.keys().next();
    if (!oldest.done) clients.delete(oldest.value);
  }
  clients.set(key, client);
  return client;
}

/**
 * Exchange the service account for an access token.
 *
 * Throws when the exchange fails, which is the signal the gateway needs: a
 * deleted key, a disabled service account or a revoked role all surface here
 * rather than as a 401 from Vertex, because they stop the request before it is
 * sent. The caller treats a throw the same way it treats a vendor 403.
 */
export async function mintVertexAccessToken(
  credential: VertexServiceAccountCredential,
): Promise<string> {
  const { token } = await clientFor(credential).getAccessToken();
  if (!token) {
    throw new Error('Vertex service account produced no access token');
  }
  return token;
}

/**
 * The API host that serves a Vertex location.
 *
 * `global` is its own endpoint rather than a region prefix — Vertex's
 * meta-endpoint, which routes to wherever the requested model is actually
 * served. Sending `global-aiplatform.googleapis.com` resolves nowhere.
 */
export function vertexHostForLocation(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
}
