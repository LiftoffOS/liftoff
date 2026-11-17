// Tenant Context (Phase 4A / 4B)
//
// AsyncLocalStorage-based per-request tenant scope. Every inbound request
// handler that deals with tenant-scoped data (credentials, memory, actions)
// MUST run inside `runWithTenantContext(ctx, fn)` so downstream code paths
// — credential fetch, outbound HTTP agent factories, rate-limiter lookups —
// can assert the tenant they are operating on matches the active context.
//
// Why AsyncLocalStorage instead of threading tenantId through every function:
//   - Pure parameter-passing is brittle (someone adds a helper, forgets to
//     pass tenantId, it silently falls back to process-wide state, and a
//     tenant A caller ends up reading a tenant B cached credential).
//   - ALS binds the context to the continuation that started it; async
//     awaits preserve the context automatically; concurrent requests to
//     different tenants see different stores.
//   - The `assertTenantContext(claimedId)` pattern gives us a cheap
//     run-time check at every sensitive boundary: if someone reaches a
//     credential fetch with a tenant id that doesn't match the active
//     context, we throw instead of leaking.
//
// Pair this with:
//   - verifyTenantJwt (src/security/verify-tenant-jwt.ts) to establish the
//     authenticated claims before entering `runWithTenantContext`.
//   - requireServiceAuth decorator (src/security/service-auth.ts) to make
//     sure no mounted route bypasses the check.

import { AsyncLocalStorage } from 'async_hooks';

/**
 * Tenant-scoped request context. Populated at the edge of the service after
 * JWT verification; readable by any downstream code running in the same async
 * continuation.
 *
 * `jwtClaims` carries the verified claims from the Platform Backend's OIDC
 * token. Downstream code should treat them as authoritative — anything
 * derived from a request body is caller-supplied and untrusted.
 */
export interface TenantContext {
  tenantId: string;
  agentId?: string;
  invocationId?: string;
  jwtClaims?: {
    aud: string | string[];
    iss: string;
    exp: number;
    sub: string;
  };
}

/**
 * The AsyncLocalStorage instance. Exported for tests that need to inspect
 * context propagation; production code should use the helpers below.
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Thrown when code paths that require an active tenant context are invoked
 * outside of `runWithTenantContext`. This is a programming error, not a
 * security bypass — but we throw loudly to make the bug obvious the first
 * time it hits instead of silently operating with no tenant scope.
 */
export class TenantContextMissingError extends Error {
  constructor(message = 'No active tenant context — caller must be wrapped in runWithTenantContext') {
    super(message);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Thrown when a caller's claimed tenantId does not match the active tenant
 * context. This is the load-bearing safety check for cross-tenant access:
 * if this throws, it means a code path tried to operate on tenant B data
 * while the active request was authenticated as tenant A.
 */
export class TenantContextMismatchError extends Error {
  public readonly activeTenantId: string;
  public readonly claimedTenantId: string;

  constructor(activeTenantId: string, claimedTenantId: string) {
    super(
      `Tenant context mismatch: active=${activeTenantId}, claimed=${claimedTenantId}`,
    );
    this.name = 'TenantContextMismatchError';
    this.activeTenantId = activeTenantId;
    this.claimedTenantId = claimedTenantId;
  }
}

/**
 * Run `fn` inside a tenant-scoped async continuation. Any `await` chain
 * started inside `fn` inherits the context. Sibling continuations started
 * outside `fn` do NOT see the context — that is the invariant we rely on
 * for tenant isolation.
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  if (!ctx.tenantId) {
    throw new Error('runWithTenantContext: ctx.tenantId is required');
  }
  return tenantContextStorage.run(ctx, fn);
}

/**
 * Get the current tenant context. Throws if no context is active — callers
 * who tolerate absence should use `getCurrentTenantContextOrUndefined`.
 */
export function getCurrentTenantContext(): TenantContext {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new TenantContextMissingError();
  }
  return ctx;
}

/**
 * Get the current tenant context or undefined. Useful for logging helpers
 * that should degrade gracefully outside tenant-scoped code (e.g. startup,
 * shutdown, background tasks that legitimately run without a tenant).
 */
export function getCurrentTenantContextOrUndefined(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}

/**
 * Assert that the current tenant context matches `claimedTenantId`. Call
 * this at every sensitive boundary (credential fetch, cross-tenant DB
 * query, outbound HTTP agent factory) BEFORE using the claimed id. This
 * catches logic bugs where a tenantId is pulled from a request body or
 * a stale closure instead of the authenticated context.
 */
export function assertTenantContext(claimedTenantId: string): void {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new TenantContextMissingError(
      `assertTenantContext(${claimedTenantId}) called outside a tenant-scoped continuation`,
    );
  }
  if (ctx.tenantId !== claimedTenantId) {
    throw new TenantContextMismatchError(ctx.tenantId, claimedTenantId);
  }
}

/**
 * Express middleware that extracts tenant context from `req.ctx` (populated
 * by the app's existing trace-context middleware) and wraps the rest of the
 * request pipeline inside `runWithTenantContext`. Safe to mount globally —
 * requests without a tenantId fall through without establishing a context.
 *
 * The JWT claims are expected to already be on `req.tenantJwtClaims` by the
 * time this runs (populated by verifyTenantJwt). Only include claims we can
 * trust, not anything the caller could have smuggled via body/query.
 */
export function tenantContextMiddleware(
  req: {
    ctx?: { tenantId?: string; agentId?: string; invocationId?: string };
    tenantJwtClaims?: { aud: string | string[]; iss: string; exp: number; sub: string };
  },
  _res: unknown,
  next: () => void,
): void {
  const tenantId = req.ctx?.tenantId;
  if (!tenantId) {
    next();
    return;
  }
  const ctx: TenantContext = {
    tenantId,
    agentId: req.ctx?.agentId,
    invocationId: req.ctx?.invocationId,
    jwtClaims: req.tenantJwtClaims,
  };
  runWithTenantContext(ctx, () => {
    next();
  });
}
