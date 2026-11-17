// OIDC guard for the Cloud Tasks worker routes under /api/internal/chat-turns.
//
// One verifier for every worker on the chat-turns queue, extracted from
// chat-turn-worker.ts when the redistill-accept worker became its second
// caller: two copies of an auth check drift, and the one that drifts loose is
// the one that was pasted.
//
// Accepts either the queue SA's OIDC token (audience = this backend, email
// pinned to CHAT_TURNS_INVOKER_SA) or, when no bearer is present, the local-dev
// shared secret — the same fallback the MCP chat-run worker uses, because local
// runs have no Cloud Tasks to mint a token.

import type { Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { getBackendUrl } from '../infrastructure/control-plane-url';

const oidcClient = new OAuth2Client();

export async function verifyWorkerOidc(req: Request): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // Local dev fallback: shared internal secret.
    return req.headers['x-internal-secret'] === process.env.INTERNAL_SERVICE_SECRET
      && Boolean(process.env.INTERNAL_SERVICE_SECRET);
  }
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience: getBackendUrl(),
    });
    const email = ticket.getPayload()?.email ?? '';
    const expected = process.env.CHAT_TURNS_INVOKER_SA;
    return Boolean(expected) && email === expected;
  } catch {
    return false;
  }
}
