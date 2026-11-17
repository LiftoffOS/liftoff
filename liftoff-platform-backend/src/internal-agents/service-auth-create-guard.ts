// Service-auth (HRBP) create boundary. A service-auth create caller
// can NEVER smuggle modelConfig, a cross-tenant tenantId, or a non-draft
// status through the create tool: tenantId comes from the authenticated
// context, modelConfig is applied server-side (tier-derived), and status is
// forced to 'draft'. Isolated in its own module (no heavy router imports) so
// the boundary is unit-tested directly.
//
// Why status belongs here rather than in the caller:
//
// POST /api/internal-agents (the UI path) answers 402 when the body says
// status:'active' and the workspace has no plan. POST /api/internal-agents/_svc
// has no such guard and runs no Zod at all, so whatever `status` arrives is
// passed straight through to the INSERT — the only thing rejecting a bad value
// is the migration-016 CHECK constraint, which surfaces as a 500.
//
// Until now the only thing keeping an active agent off that route was that the
// single caller, HRBP's teambuilder__create in liftoff-workforce-service,
// happens to hardcode status:'draft' in its request body. That held, but it
// put the paywall's integrity in a different repo, enforced by a convention
// rather than by the boundary. It became load-bearing the moment HRBP was
// deliberately allowed to run for tenants with no subscription: HRBP now
// builds teams for people who have not paid, and the thing that stops those
// teams from running has to be here, next to the money authority.
//
// Forcing rather than rejecting is deliberate. The one live caller already
// sends 'draft', so forcing is behaviour-identical for it today, while a 400
// would turn any future caller's mistake into a broken provisioning saga
// instead of a draft the user can launch themselves. 'paused' is forced too:
// the status enum is draft | active | paused, and a service-auth create has no
// business producing either of the other two.
//
// Nothing legitimate is lost. Activation has its own route,
// PATCH /api/internal-agents/:id/status, which carries the 402.

/** Return a copy of a service-auth create request body with the fields a
 * service-auth caller must not set removed (modelConfig, tenantId) and
 * `status` pinned to 'draft'. */
export function stripServiceAuthCreateBody(reqBody: unknown): Record<string, unknown> {
  const body = {...((reqBody ?? {}) as Record<string, unknown>) };
  delete body.modelConfig;
  delete body.tenantId;
  body.status = 'draft';
  return body;
}
