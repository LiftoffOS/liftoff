// The `x-origin` header: where an assistant turn came from, carried
// across the service hop.
//
// When a Chief AI Officer turn is started by the MCP chat worker on behalf of
// a coding tool, the worker knows the tool (the anchor token's name) and the
// anchor id. That knowledge has to travel: platform-backend → workforce
// (with the turn) → platform-backend again (with every workspace action the
// CAIO performs), so the audit row for an action the CAIO took says "from
// Claude Code through the Chief AI Officer" and not only "Chief AI Officer".
// One JSON header, written by buildOriginHeader and read by
// parseLiftoffOriginHeader, so the two directions cannot disagree on its
// shape.

import type { ActorOrigin } from './actor';

export const LIFTOFF_ORIGIN_HEADER = 'x-origin';

export function buildOriginHeader(origin: ActorOrigin | null | undefined): Record<string, string> {
  if (!origin) return {};
  return { [LIFTOFF_ORIGIN_HEADER]: JSON.stringify({ via: origin.via, client: origin.client, credentialId: origin.credentialId }) };
}

export function parseLiftoffOriginHeader(raw: unknown): ActorOrigin | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as { via?: unknown; client?: unknown; credentialId?: unknown };
    if (parsed.via !== 'mcp' && parsed.via !== 'slack' && parsed.via !== 'teams') return null;
    return {
      via: parsed.via,
      client: typeof parsed.client === 'string' ? parsed.client : '',
      credentialId: typeof parsed.credentialId === 'string' ? parsed.credentialId : '',
    };
  } catch {
    return null;
  }
}
