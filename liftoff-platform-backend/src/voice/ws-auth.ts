// Authenticating a voice WebSocket, once, for every voice WebSocket.
//
// Browsers cannot set an Authorization header on an upgrade. The Firebase ID
// token therefore travels as a SUBPROTOCOL rather than a query parameter,
// because query strings are recorded in access logs and a bearer token has no
// business being there. No ticket table and no shared state between instances —
// the same verification the REST routes already do.
//
// Listening and speaking authorise identically, so this is stated once. Two
// copies of an auth preamble is how one of them ends up a fix behind.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from '../auth/jwt';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import type { DictationSurface } from './cost';

/** Subprotocol offered alongside the token, so the two are unambiguous. */
export const AUTH_PROTOCOL = 'voice';

/** Close codes the client distinguishes. 1000 is a normal finish. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4404;
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UPSTREAM = 4500;

export interface VoiceSessionContext {
  tenantId: string;
  /** Which chat this is. Decides who pays, so it is declared, never inferred. */
  surface: DictationSurface;
  agentId: string | undefined;
  accountId: string;
  requestId: string;
  /** Query parameters beyond the shared ones, for a socket that needs more. */
  params: URLSearchParams;
}

/**
 * Surfaces that can open a voice socket — the browser ones.
 *
 * Slack and Teams are voice surfaces too, but they arrive as finished files over
 * their own webhooks and never hold a socket, so accepting them here would only
 * widen what an attacker can ask for.
 */
function isVoiceSurface(value: string | null): value is DictationSurface {
  return value === 'agent_chat' || value === 'team_plan' || value === 'insights';
}

/**
 * Authenticate and authorise an upgrade.
 *
 * Mirrors the REST preamble exactly, including answering a non-member the same
 * way as an unknown tenant so membership cannot be probed over this seam either.
 */
async function authorize(
  req: IncomingMessage,
  accountService: AccountService,
): Promise<{ ok: true; ctx: VoiceSessionContext } | { ok: false; code: number }> {
  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (protocols[0] !== AUTH_PROTOCOL || !protocols[1]) {
    return { ok: false, code: CLOSE_UNAUTHORIZED };
  }

  const payload = await verifyToken(protocols[1]);
  if (!payload) return { ok: false, code: CLOSE_UNAUTHORIZED };

  const params = new URL(req.url ?? '', 'http://placeholder').searchParams;
  const tenantId = params.get('tenantId');
  const surface = params.get('surface');
  if (!tenantId || !isVoiceSurface(surface)) {
    return { ok: false, code: CLOSE_BAD_REQUEST };
  }

  const account = await accountService.getByFirebaseUid(payload.uid);
  if (!account) return { ok: false, code: CLOSE_UNAUTHORIZED };

  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) return { ok: false, code: CLOSE_FORBIDDEN };

  return {
    ok: true,
    ctx: {
      tenantId,
      surface,
      agentId: params.get('agentId') ?? undefined,
      accountId: account.id,
      requestId: (req.headers['x-request-id'] as string) || randomUUID(),
      params,
    },
  };
}

/**
 * Serve one voice WebSocket path.
 *
 * `noServer: true` plus a path check, so each socket coexists with the others
 * and with any unrelated upgrade handler instead of claiming every upgrade.
 */
export function attachVoiceSocket(
  server: Server,
  path: string,
  onSession: (ws: WebSocket, ctx: VoiceSessionContext) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const accountService = new AccountService();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '', 'http://placeholder').pathname;
    } catch {
      return;
    }
    if (pathname !== path) return;

    void (async () => {
      const result = await authorize(req, accountService);
      if (!result.ok) {
        // Refuse before the handshake completes. A rejected upgrade is an HTTP
        // response, not a close frame.
        const status = result.code === CLOSE_FORBIDDEN ? '404 Not Found' : '401 Unauthorized';
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Echo the auth subprotocol; browsers require the server to select one of
        // the offered protocols or the connection is dropped.
        onSession(ws, result.ctx);
      });
    })();
  });

  return wss;
}
