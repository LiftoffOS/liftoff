// Express Middleware
// Per Section 18: Correlation IDs across every request

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { createLogger, LogContext, logError, setTraceContext } from './logging';
import { getTracer } from './tracing';
import { context, trace } from '@opentelemetry/api';
import { verifyIdToken } from './firebase';

// Authenticated user info attached to request
export interface AuthUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  // Firebase sign-in provider (firebase.sign_in_provider claim): 'password',
  // 'google.com', 'custom' (passkey), etc. Used by requireVerifiedEmail to
  // exempt federated providers, which already assert the email address.
  signInProvider?: string;
  displayName?: string;
  photoURL?: string;
  // Seconds-since-epoch of the last actual sign-in, from the token's auth_time
  // claim. Distinct from iat, which refreshes silently every hour: auth_time
  // only moves when a person authenticates. Support delegation uses it to
  // require a fresh sign-in before a grant, so a long-lived admin session is
  // not by itself enough to open a customer's workspace.
  authTime?: number;
}

// Extend Express Request to include context
declare global {
  namespace Express {
    interface Request {
      ctx: LogContext;
      log: ReturnType<typeof createLogger>;
      user?: AuthUser;
    }
  }
}

// Per Section 18: Correlation IDs middleware
// Phase 1 fix: Do NOT trust X-Tenant-ID from the header. Tenant context
// is populated only after tenantAuthMiddleware verifies membership.
// The header is still read for logging/tracing of unauthenticated requests,
// but ctx.tenantId is set to undefined here and overwritten after auth.
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string || randomUUID();

  // Set correlation ID in response headers
  res.setHeader('x-request-id', requestId);

  // Create request context — tenantId is NOT set from header.
  // It will be populated after tenantAuthMiddleware verifies membership.
  const ctx: LogContext = {
    requestId,
    tenantId: undefined,
    operation: `${req.method} ${req.path}`,
  };

  req.ctx = ctx;
  req.log = createLogger(ctx);

  // Log request start
  req.log.info({ event: 'request_start', method: req.method, path: req.path });

  // Log request completion
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    req.log.info({
      event: 'request_end',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
    });
  });

  next();
}

// Per Section 18: Tracing middleware
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tracer = getTracer();
  const span = tracer.startSpan(`${req.method} ${req.path}`);

  // Add request attributes to span
  span.setAttribute('http.method', req.method);
  span.setAttribute('http.url', req.url);
  span.setAttribute('http.target', req.path);

  if (req.ctx?.tenantId) {
    span.setAttribute('tenant_id', req.ctx.tenantId);
  }

  // Run request in span context
  context.with(trace.setSpan(context.active(), span), () => {
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    next();
  });
}

// Authentication middleware - verifies Firebase ID token
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid authorization header',
      requestId: req.ctx?.requestId,
    });
    return;
  }

  const idToken = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const decodedToken = await verifyIdToken(idToken);

    // Attach user info to request
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified || false,
      signInProvider: decodedToken.firebase?.sign_in_provider,
      displayName: decodedToken.name,
      photoURL: decodedToken.picture,
      authTime: decodedToken.auth_time,
    };

    // Add user ID to logging context
    if (req.ctx) {
      req.ctx.userId = decodedToken.uid;
    }

    req.log?.debug({ userId: decodedToken.uid }, 'User authenticated');
    next();
  } catch (error) {
    req.log?.warn({ error }, 'Token verification failed');
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
      requestId: req.ctx?.requestId,
    });
  }
}

// Optional auth middleware - attaches user if token present, continues otherwise
export async function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const idToken = authHeader.substring(7);

  try {
    const decodedToken = await verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified || false,
      displayName: decodedToken.name,
      photoURL: decodedToken.picture,
    };

    if (req.ctx) {
      req.ctx.userId = decodedToken.uid;
    }
  } catch {
    // Token invalid but that's okay for optional auth
  }

  next();
}

// Error handling middleware
export function errorMiddleware(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Log with full stack trace for debugging
  console.error('[errorMiddleware] Unhandled error:', err.message, err.stack);
  logError(err, req.ctx || {}, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.ctx?.requestId,
  });
}

// Health check endpoint
// Per Section 18: Each trace should include these IDs
export function healthCheck(req: Request, res: Response): void {
  res.json({
    status: 'healthy',
    service: 'liftoff-platform-backend',
    version: process.env.SERVICE_VERSION || '0.1.0',
    environment: process.env.ENVIRONMENT || 'dev',
  });
}

// Ready check endpoint - verifies DB connectivity
export async function readyCheck(req: Request, res: Response): Promise<void> {
  try {
    // Import here to avoid circular dependency
    const { pool } = await import('./database');
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready', error: 'Database unavailable' });
  }
}

// [SE-001, SE-004] Tenant authorization middleware
// Role hierarchy for permission checks
export const ROLE_HIERARCHY = { owner: 4, admin: 3, member: 2, viewer: 1 } as const;

// The MATRIX is still imported dynamically below, because it is a value and the
// cycle is real. The TYPE is not: `import type` is erased before anything runs,
// so it cannot participate in a cycle — and the hand-copy this replaces had
// already fallen behind, which is the failure that copy invites. A permission
// added to the role table but missing here does not fail as a missing
// permission: it fails as a type error at the call site, naming a string the
// table already knows, which reads as a typo in the caller.
export type { Permission } from '../tenant-members/types';
import type { Permission } from '../tenant-members/types';

/** The tenant id a `/tenant/:tenantId` route carries in its path.
 *
 *  Anchored on the `/tenant/` segment rather than "find a uuid anywhere", so a
 *  route that happens to carry some OTHER id cannot be mistaken for a tenancy
 *  claim. Returns undefined for anything that is not a uuid. */
export function tenantIdFromPath(originalUrl: string | undefined): string | undefined {
  if (!originalUrl) return undefined;
  const path = originalUrl.split('?')[0];
  const m = /\/tenant\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path);
  return m ? m[1] : undefined;
}

export function tenantAuthMiddleware(requiredPermission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Dynamic imports to avoid circular dependencies
      const { tenantMembersService } = await import('../tenant-members/service');
      const { AccountService } = await import('../accounts/service');
      const { ROLE_PERMISSIONS } = await import('../tenant-members/types');

      // Resolve tenantId from route params, query string, or request body.
      //
      // The path fallback is not redundant. This guard is usually attached with
      // `app.use('/api/x', tenantAuthMiddleware(...), xRouter)`, and Express
      // populates `req.params` from the MOUNT path only — a `:tenantId`
      // declared on a route INSIDE the router is not visible here. So for every
      // route shaped `/tenant/:tenantId`, all three sources were undefined, the
      // membership lookup ran as `getMembership(undefined, actor)`, and the
      // request was refused 403 for its own tenant.
      //
      // It failed silently because it fails for EVERYONE equally, so it reads
      // as "this endpoint needs different permissions" rather than as a bug.
      // Found via /api/feature-flags/tenant/:tenantId, which the browser pane
      // affordance reads: the endpoint 403'd on every page load, the flags
      // query had no data, and every workspace without its own browser
      // connector was shown no browser at all.
      //
      // Reading the id from the path is exactly as safe as reading it from
      // params: it is a CLAIM either way, and the membership check below is
      // what authorises it.
      const tenantId = req.params.tenantId
        || req.query.tenantId as string
        || (req.body as any)?.tenantId
        || tenantIdFromPath(req.originalUrl)
        || undefined;
      const { accountId: targetAccountId } = req.params;

      // Get account ID from Firebase UID
      const firebaseUid = req.user?.uid;
      if (!firebaseUid) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const accountService = new AccountService();
      const account = await accountService.getByFirebaseUid(firebaseUid);
      const actorAccountId = account?.id;

      if (!actorAccountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // 1. Verify actor is member of tenant
      const membership = await tenantMembersService.getMembership(tenantId, actorAccountId);
      if (!membership) {
        return res.status(403).json({ error: 'Not a member of this tenant' });
      }

      // 2. [SE-004] IDOR protection: verify target exists in same tenant
      if (targetAccountId) {
        const targetMembership = await tenantMembersService.getMembership(tenantId, targetAccountId);
        if (!targetMembership) {
          return res.status(404).json({ error: 'Member not found' });
        }

        // [SE-001] Owner demotion protection
        if (requiredPermission === 'changeRole' || requiredPermission === 'removeMember') {
          if (targetMembership.role === 'owner' && membership.role !== 'owner') {
            return res.status(403).json({ error: 'Cannot modify owner' });
          }
        }
      }

      // 3. Check permission
      if (!ROLE_PERMISSIONS[membership.role][requiredPermission]) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      // Attach to request for downstream use
      (req as any).membership = membership;
      (req as any).actorAccountId = actorAccountId;

      // Phase 1: Set verified tenant context AFTER membership check.
      // This is the ONLY place tenantId should be set on the request context.
      if (tenantId && req.ctx) {
        req.ctx.tenantId = tenantId;
      }

      // WS-1.1 (PB mirror) — bind tenantId to the logging trace context so
      // every subsequent log emission inside this request carries
      // attribution. Without this, PB-side logs from service-layer code
      // show no tenant_id field even when the route handler knows it.
      if (tenantId) setTraceContext({ tenantId });

      next();
    } catch (error) {
      next(error);
    }
  };
}

// NOTE: tenant-scoped DB access lives in the service layer.
// Public service functions accept `tenantId` and open `withTenantScope`
// internally (see workflow-engine/run-service.ts for the canonical
// example). Handlers stay thin: parse → authorize via
// `tenantAuthMiddleware` → call `service.method(tenantId, …)`.
// Don't reintroduce middleware-level transaction scoping — Express's
// `next()` contract doesn't compose with "keep a transaction open
// across the response," and the rest of the codebase already follows
// the service-owns-scope pattern.
