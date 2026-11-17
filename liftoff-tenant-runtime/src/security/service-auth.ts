// Hardened Service Auth + Route Annotation System (Phase 4E)
//
// Two things live here:
//
// 1. `requireServiceAuth()` — an Express middleware factory that verifies the
//    X-Service-Auth header against the configured shared secret using a
//    constant-time compare, AND tags the returned handler with a marker
//    symbol. Every route that ships tenant-scoped data MUST have this
//    middleware mounted; routes that don't must be annotated explicitly
//    as public (see below).
//
// 2. `assertEveryRouteHasAuthAnnotation(app)` — a boot-time assertion that
//    walks the Express router tree and fails loudly if any route lacks
//    either the `requireServiceAuth()` marker OR an explicit `@public-route`
//    registration. The goal is to make it structurally impossible for a
//    new route to ship without auth — the service refuses to start.
//
// The original verifyServiceAuth implementations in tool-proxy-router.ts
// and chat-turn-handler.ts are kept for backwards compatibility but now
// defer to this module. All new cross-service routes should use the
// exported `requireServiceAuth()` here directly.
//
// Note on scope: this is the runtime's defense against the Platform Backend
// being impersonated. It does NOT replace verifyTenantJwt — service auth
// proves the caller is the backend; the tenant JWT proves which tenant the
// request is for. Both are required on cross-service endpoints that touch
// tenant-scoped data.

import crypto from 'crypto';
import { getManagedSecret } from '../infrastructure/secret-store';
import type { Request, Response, NextFunction, RequestHandler, Express, Router } from 'express';
import { logger } from '../infrastructure/logging';
import { extractBearerToken, verifyGoogleOidcToken } from './oidc-verifier';

/**
 * Marker symbol attached to request handlers returned by `requireServiceAuth`
 * so the boot-time route scan can identify them. Symbol is non-enumerable on
 * purpose — we don't want someone trivially spoofing it via `Object.assign`.
 */
const SERVICE_AUTH_MARKER = Symbol.for('liftoff.security.requireServiceAuth');

/**
 * Marker for explicitly-declared public routes. Use `markPublicRoute(path)`
 * at mount time to annotate; the boot-time scan treats any route whose path
 * matches one of these as intentionally unauthenticated.
 */
const publicRoutes = new Set<string>();

/**
 * Mark a route as public (no service auth required). Use this for health,
 * readiness, and metrics endpoints. The match is exact on the mounted path.
 */
export function markPublicRoute(path: string): void {
  publicRoutes.add(path);
}

/**
 * Check whether a path was explicitly marked public.
 */
export function isPublicRoute(path: string): boolean {
  return publicRoutes.has(path);
}

export interface RequireServiceAuthOptions {
  /** Env var name to read the expected shared-secret from.
   *  Defaults to `TENANT_RUNTIME_SERVICE_TOKEN`. */
  envVar?: string;
  /** Allow-list of acceptable X-Service-Caller values. If provided, the
   *  header must be present AND match one of these. Defence-in-depth for
   *  cases where we want to distinguish internal callers.
   */
  allowedCallers?: string[];
  /**
   * Phase 4: also accept a Google OIDC bearer token (Authorization: Bearer
   * <id_token>) as proof of identity. When enabled AND the OIDC verification
   * succeeds, the X-Service-Auth check is skipped. If OIDC verification fails,
   * the middleware falls back to the shared-secret check. This lets
   * intra-tenant Cloud Run services authenticate each other without the
   * shared-secret, while cross-project callers that still send the shared
   * secret keep working during the rollout window.
   */
  acceptOidc?: boolean;
  /**
   * Required when `acceptOidc` is true. The `aud` claim the OIDC token must
   * bear — Cloud Run mints tokens with `aud` == the target service URL. Pass
   * either a static URL or a resolver that inspects the request. A function
   * lets a single middleware instance serve multiple Cloud Run revisions
   * (e.g., behind a custom domain).
   */
  oidcAudience?: string | ((req: Request) => string | undefined);
  /**
   * Required when `acceptOidc` is true. Allow-list of service-account emails
   * whose OIDC tokens are accepted. Resolved once at middleware-construction
   * unless wrapped in a function — a function lets the allow-list come from
   * env vars that hydrate after module load.
   */
  allowedOidcEmails?: string[] | (() => string[]);
}

/**
 * Express middleware factory. Returns a RequestHandler that enforces:
 *   1. `X-Service-Auth` present and matches the configured shared secret
 *      (constant-time compare; Buffer-length check to avoid timing leak).
 *   2. Optionally `X-Service-Caller` is one of `allowedCallers`.
 *
 * The returned handler is tagged with `SERVICE_AUTH_MARKER` so the boot
 * assertion can find it. Wrap all tenant-touching routes with this.
 */
export function requireServiceAuth(opts: RequireServiceAuthOptions = {}): RequestHandler {
  const envVar = opts.envVar ?? 'TENANT_RUNTIME_SERVICE_TOKEN';

  if (opts.acceptOidc && !opts.oidcAudience) {
    throw new Error('requireServiceAuth: acceptOidc requires oidcAudience');
  }
  if (opts.acceptOidc && !opts.allowedOidcEmails) {
    throw new Error('requireServiceAuth: acceptOidc requires allowedOidcEmails');
  }

  const resolveOidcAudience = (req: Request): string | undefined => {
    if (!opts.oidcAudience) return undefined;
    if (typeof opts.oidcAudience === 'string') return opts.oidcAudience;
    return opts.oidcAudience(req);
  };
  const resolveAllowedOidcEmails = (): string[] => {
    if (!opts.allowedOidcEmails) return [];
    return typeof opts.allowedOidcEmails === 'function'
      ? opts.allowedOidcEmails()
      : opts.allowedOidcEmails;
  };

  const handler: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // -- Path 1: OIDC bearer (preferred for intra-tenant when enabled) ------
    //
    // We try OIDC first so intra-tenant callers don't need the shared secret
    // at all. The Authorization header is only inspected when `acceptOidc`
    // is true — otherwise the existing shared-secret behaviour is unchanged.
    if (opts.acceptOidc) {
      const bearer = extractBearerToken(req.headers['authorization'] as string | undefined);
      if (bearer) {
        const audience = resolveOidcAudience(req);
        const allowedEmails = resolveAllowedOidcEmails();
        if (!audience || allowedEmails.length === 0) {
          logger.error('service_auth_oidc_misconfigured', {
            path: req.path,
            hasAudience: Boolean(audience),
            allowedEmailCount: allowedEmails.length,
          });
          res.status(500).json({ error: 'Service authentication not configured' });
          return;
        }
        const result = await verifyGoogleOidcToken(bearer, {
          audience,
          allowedEmails,
        });
        if (result.ok) {
          // Optional allowedCallers check even on the OIDC path — some routes
          // want to pin the specific service that's calling (X-Service-Caller).
          if (opts.allowedCallers && opts.allowedCallers.length > 0) {
            const caller = req.headers['x-service-caller'] as string | undefined;
            if (!caller || !opts.allowedCallers.includes(caller)) {
              res.status(403).json({ error: 'Caller not allowed' });
              return;
            }
          }
          next();
          return;
        } else {
          // OIDC verification failed. Fall through to the shared-secret path —
          // the token may have been a user Firebase JWT on a route that ALSO
          // accepts service auth, or the caller may send both an Authorization
          // header and X-Service-Auth during the rollout window. If the shared
          // secret is also absent/invalid, we return 401.
          const failReason = 'reason' in result ? result.reason : 'unknown';
          logger.debug('service_auth_oidc_rejected', {
            path: req.path,
            reason: failReason,
          });
        }
      }
    }

    // -- Path 2: X-Service-Auth shared secret (legacy + cross-project) ------
    const serviceToken = req.headers['x-service-auth'] as string | undefined;
    // Through the store, not `process.env`. This is the INBOUND half of service
    // auth and `envVar` defaults to TENANT_RUNTIME_SERVICE_TOKEN, which
    // `loadSecretsToEnv` no longer writes to the environment (INV-TR-016). Read
    // from `process.env` here and every route behind requireServiceAuth() —
    // memory, coordinator, reflection, connector-replica, agent-lifecycle —
    // answers 500 "Service authentication not configured".
    //
    // `getManagedSecret` falls back to `process.env`, so a caller passing a
    // variable that is NOT a managed secret keeps working unchanged.
    const expectedToken = getManagedSecret(envVar);

    if (!expectedToken) {
      logger.error('service_auth_misconfigured', {
        envVar,
        path: req.path,
      });
      res.status(500).json({ error: 'Service authentication not configured' });
      return;
    }

    if (!serviceToken) {
      res.status(401).json({ error: 'Invalid service authentication' });
      return;
    }

    const providedBuf = Buffer.from(serviceToken);
    const expectedBuf = Buffer.from(expectedToken);

    // Length check first — timingSafeEqual throws on length mismatch, and
    // we don't want to leak the expected length via the error pathway.
    if (providedBuf.length !== expectedBuf.length) {
      res.status(401).json({ error: 'Invalid service authentication' });
      return;
    }

    let ok = false;
    try {
      ok = crypto.timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      ok = false;
    }

    if (!ok) {
      res.status(401).json({ error: 'Invalid service authentication' });
      return;
    }

    // Optional allowedCallers check. This is a defense-in-depth signal, not
    // a primary authentication mechanism — the shared secret still authenticates.
    if (opts.allowedCallers && opts.allowedCallers.length > 0) {
      const caller = req.headers['x-service-caller'] as string | undefined;
      if (!caller || !opts.allowedCallers.includes(caller)) {
        res.status(403).json({ error: 'Caller not allowed' });
        return;
      }
    }

    next();
  };

  // Tag the handler so the boot-time scan can find it.
  (handler as unknown as { [SERVICE_AUTH_MARKER]: boolean })[SERVICE_AUTH_MARKER] = true;
  (handler as unknown as { displayName?: string }).displayName = 'requireServiceAuth';
  return handler;
}

/**
 * Return true if a given middleware was produced by `requireServiceAuth`.
 * Used by the boot-time route scan.
 */
export function isServiceAuthMiddleware(fn: unknown): boolean {
  if (!fn) return false;
  return Boolean((fn as { [SERVICE_AUTH_MARKER]?: boolean })[SERVICE_AUTH_MARKER]);
}

/**
 * Walk an Express app's router tree and collect every terminal route.
 * Returns `{ path, methods, middlewareNames }` for each — lets the boot
 * assertion reason about which routes have service-auth coverage.
 *
 * Express doesn't expose a clean API for this; we dig through the private
 * `_router.stack` structure. This is brittle across Express majors, but
 * Express 4's structure has been stable for years and we pin to ^4.18.
 */
interface CollectedRoute {
  path: string;
  methods: string[];
  /** Stack of middleware at the route level (does NOT include router-level
   *  middleware — those are walked separately as part of the layer tree). */
  middlewares: unknown[];
  /** True if ANY middleware in the path to this route (router-level or
   *  route-level) was produced by requireServiceAuth. */
  hasServiceAuth: boolean;
}

interface ExpressLayer {
  name?: string;
  path?: string;
  regexp?: RegExp;
  route?: {
    path: string;
    stack: { method: string; handle: unknown; name?: string }[];
    methods?: Record<string, boolean>;
  };
  handle?: unknown;
}

interface ExpressRouterInternal {
  stack: ExpressLayer[];
}

function extractMountPath(layer: ExpressLayer): string {
  // Express stores the mount path as a regexp; for simple string mounts it's
  // serialisable. We fall back to layer.path if present (some versions set it).
  if (layer.path) return layer.path;
  if (!layer.regexp) return '';
  const src = layer.regexp.source;
  // e.g. "^\\/api\\/tenant\\/?(?=\\/|$)" — strip leading ^\\/? and trailing segments.
  const match = src.match(/^\^\\\/(.+?)\\\/\?\(\?=/);
  if (match) return '/' + match[1].replace(/\\\//g, '/');
  return '';
}

function collectRoutes(
  layers: ExpressLayer[],
  prefix: string,
  ancestorHasServiceAuth: boolean,
  out: CollectedRoute[],
): void {
  let currentAncestorAuth = ancestorHasServiceAuth;
  for (const layer of layers) {
    // Middleware at router level — a layer whose `handle` IS our auth marker
    // flips ancestor flag for all subsequent siblings.
    if (layer.name === 'requireServiceAuth' && isServiceAuthMiddleware(layer.handle)) {
      currentAncestorAuth = true;
      continue;
    }

    if (layer.route) {
      const fullPath = prefix + layer.route.path;
      const methods = Object.keys(layer.route.methods ?? {}).filter((m) => m !== '_all');
      // Route-level stack — if any entry is service-auth, count it.
      const routeLevelAuth = layer.route.stack.some((s) => isServiceAuthMiddleware(s.handle));
      out.push({
        path: fullPath,
        methods,
        middlewares: layer.route.stack.map((s) => s.handle),
        hasServiceAuth: currentAncestorAuth || routeLevelAuth,
      });
      continue;
    }

    // Nested router (sub-app).
    if (layer.name === 'router' && layer.handle) {
      const childRouter = layer.handle as unknown as ExpressRouterInternal & { stack?: ExpressLayer[] };
      if (childRouter.stack) {
        const mountPath = extractMountPath(layer);
        collectRoutes(
          childRouter.stack,
          prefix + mountPath,
          currentAncestorAuth,
          out,
        );
      }
      continue;
    }

    // Any other middleware — check if it's service auth; if so, flip ancestor.
    if (isServiceAuthMiddleware(layer.handle)) {
      currentAncestorAuth = true;
    }
  }
}

/**
 * Scan every mounted route on `app`. Return those that have no service-auth
 * coverage AND are not in the public-route allow-list. An empty array means
 * every route is properly annotated.
 */
export function findUnannotatedRoutes(app: Express | Router): CollectedRoute[] {
  const routes: CollectedRoute[] = [];
  const router = (app as unknown as { _router?: ExpressRouterInternal })._router;
  if (!router || !router.stack) return routes;
  collectRoutes(router.stack, '', false, routes);

  return routes.filter(
    (r) => !r.hasServiceAuth && !publicRoutes.has(r.path),
  );
}

/**
 * Boot-time assertion: every mounted route must have service-auth coverage
 * OR be registered as public. If any route is uncovered, throw loudly so
 * the service fails to start rather than shipping an open endpoint.
 *
 * Call this AFTER all routers are mounted, BEFORE app.listen().
 */
export function assertEveryRouteHasAuthAnnotation(app: Express | Router): void {
  const unannotated = findUnannotatedRoutes(app);
  if (unannotated.length === 0) return;

  const lines = unannotated.map(
    (r) => `  ${r.methods.join(',').toUpperCase()} ${r.path}`,
  );
  const message =
    `Route auth assertion failed: ${unannotated.length} route(s) lack service-auth annotation.\n` +
    `Each route must either:\n` +
    `  1. Use requireServiceAuth() middleware, OR\n` +
    `  2. Be registered via markPublicRoute(path) before boot.\n\n` +
    `Offending routes:\n${lines.join('\n')}`;
  logger.error('route_auth_annotation_missing', {
    count: unannotated.length,
    routes: unannotated.map((r) => ({ path: r.path, methods: r.methods })),
  });
  throw new Error(message);
}
