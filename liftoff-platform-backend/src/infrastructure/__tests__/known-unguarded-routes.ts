// Routes that take a tenant id from the client without unconditionally proving
// the caller belongs to that tenant.
//
// THIS LIST IS EMPTY, AND THAT IS THE POINT. It is a ratchet, not a permission
// list: `tenant-scoped-routers-guarded.test.ts` walks the TS AST per route and
// fails on any route that reads a client-supplied tenant id without proving the
// caller's right to it. An entry here is the only way to exempt one.
//
// Identity is not tenancy. `authMiddleware` proves who is calling;
// `tenantAuthMiddleware` proves they belong to the tenant they named.
//
// Keeping it empty is the job now. A new entry means somebody added a route that
// reads a client-supplied tenant id and did not prove the caller's right to it,
// and the fix is one of:
//
//   * tenantAuthMiddleware / verifyTenantOwnership / requireMinRole on the route
//   * verifyTenantScopeIfNamed, where the tenant filter is optional and omitting
//     it is a cross-tenant read
//   * an unconditional membership lookup at the top of the handler
//   * service auth, if no end user should reach it at all
//
// Adding a line here instead is allowed and should be rare enough that a reviewer
// asks why. A guard nested inside an `if` BODY does not count: both HITL decision
// routes ran their membership check inside `if (approvalToCheck)`, where the value
// is null whenever the tenant runtime is unreachable — so the guard vanished
// exactly when the system was already degraded.
export const KNOWN_UNGUARDED_ROUTES: readonly string[] = [];
