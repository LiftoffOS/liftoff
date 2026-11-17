import { Router, type Request } from 'express';
import { randomUUID } from 'crypto';
import { ticketStore } from './ticket-store';
import { verifyBearerJwt } from './jwt';
import { asyncHandler } from '../shared/error-middleware';
import type { TicketCreateRequest } from '@liftoffos/sandbox-contracts';

export const authRoutes = Router();

authRoutes.post(
  '/tickets',
  asyncHandler(async (req, res) => {
    // Only callers with a valid sandbox JWT can mint tickets.
    await verifyBearerJwt(req.headers['authorization']);
    const body = req.body as TicketCreateRequest;
    const ttlMs = Math.min(((body.ttl_seconds ?? 300) * 1000), 300_000);
    const { ticket, expiresAt } = ticketStore.issue(body.purpose, ttlMs);
    res.json({ ticket, expires_at: new Date(expiresAt).toISOString() });
  }),
);

export const authSubrequestRouter = Router();

authSubrequestRouter.get(
  '/',
  asyncHandler(async (req: Request, res) => {
    const authHeader = req.headers['authorization'] as string | undefined;
    const originalUri = req.headers['x-original-uri'] as string | undefined;

    // Bearer JWT path (programmatic /v1/* access from runtime)
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const claims = await verifyBearerJwt(authHeader);
        res.setHeader('X-Sandbox-Claims', JSON.stringify({ tenantId: claims.tenantId, agentId: claims.agentId }));
        res.status(200).end();
        return;
      } catch {
        res.status(401).end();
        return;
      }
    }

    // Ticket path — extract ?ticket= from X-Original-URI and validate
    if (!originalUri) {
      res.status(401).end();
      return;
    }

    const cookieHeader = (req.headers['cookie'] as string | undefined) ?? '';
    const sessionCookie = cookieHeader.match(/sandbox-(?:vscode|vnc|cdp)-session=([^;]+)/)?.[1];

    if (sessionCookie && ticketStore.sessionValid(sessionCookie)) {
      res.status(200).end();
      return;
    }

    const url = new URL(originalUri, 'http://_');
    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
      res.status(401).end();
      return;
    }
    const claims = ticketStore.consume(ticket);
    if (!claims) {
      res.status(401).end();
      return;
    }
    // Mint a session cookie for the original ticket TTL (300s)
    const sessionId = randomUUID();
    ticketStore.sessionInsert(sessionId, claims.purpose, 300_000);
    const cookieName = claims.purpose === 'vscode' ? 'sandbox-vscode-session'
      : claims.purpose === 'vnc' ? 'sandbox-vnc-session'
      : 'sandbox-cdp-session';
    const cookiePath = claims.purpose === 'vscode' ? '/vscode/'
      : claims.purpose === 'vnc' ? '/vnc/'
      : '/cdp/';
    res.setHeader('Set-Cookie', `${cookieName}=${sessionId}; Path=${cookiePath}; HttpOnly; Max-Age=300; SameSite=Strict`);
    res.status(200).end();
  }),
);
