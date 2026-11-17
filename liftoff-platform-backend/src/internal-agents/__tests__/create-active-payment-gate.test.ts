// POST /api/internal-agents must refuse to create an ALREADY-ACTIVE agent for a
// tenant that is not cleared to run agents (ADR-050).
//
// Why this exists. Building is deliberately free: a tenant with no subscription
// can browse, assemble a team and save it as a draft. Running costs money, and
// PATCH /:id/status already returns 402 payment_required rather than activate
// without a plan. The create route did not, and "Launch Now" creates with
// status:'active' rather than creating a draft and then activating — so it
// walked past the paywall entirely and produced an agent that displays as
// active while every invocation guard (chat admission, the LLM router, the
// Slack worker, the Teams handler) refuses to run it. Looks launched, does
// nothing.
//
// The frontend raises its plan modal off this 402. A modal that is the only
// thing standing there is not a rule, so the two launch paths have to answer
// the same way at the server.
//
// This asserts the guard's SHAPE in the router source rather than mounting the
// route: the create handler needs Firebase auth, tenant-ownership middleware,
// the agent service and a database before it will run at all. The behavioural
// check is an end-to-end step — POST with status:'active' while unpaid
// must return 402. Structure is asserted (ordering, condition, status code) so
// this cannot be satisfied by a comment or by a guard placed after the write.

import * as fs from 'fs';
import * as path from 'path';

const router = fs.readFileSync(
  path.join(__dirname, '..', 'router.ts'),
  'utf8',
);

/** Body of `internalAgentsRouter.post('/', …)` — the create route. Bounded by
 *  the next route registration so a guard living in some other handler cannot
 *  satisfy these assertions. */
function createRouteBody(): string {
  const start = router.indexOf(`internalAgentsRouter.post('/', verifyTenantOwnership`);
  expect(start).toBeGreaterThan(-1);
  const rest = router.slice(start + 1);
  const nextRoute = rest.search(/\ninternalAgentsRouter\.(get|post|patch|put|delete)\(/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute);
}

describe('create-with-active payment gate', () => {
  const body = createRouteBody();

  it('calls checkExecutionAllowed inside the create route', () => {
    expect(body).toContain('checkExecutionAllowed(tenantId)');
  });

  it('gates on the requested status being active, not on every create', () => {
    // Drafts must stay free. A guard without this condition would block the
    // build-before-you-buy flow that is the whole point of ADR-050.
    expect(body).toMatch(/if\s*\(\s*parseResult\.data\.status === 'active'\s*\)/);
  });

  it('refuses with 402 payment_required, the same shape the status route uses', () => {
    expect(body).toMatch(/status\(402\)[\s\S]{0,120}payment_required/);
  });

  it('surfaces the guard reason so the modal can show why', () => {
    expect(body).toMatch(/reason:\s*guardResult\.reason/);
  });

  it('runs the guard BEFORE the agent is created', () => {
    const guardAt = body.indexOf('checkExecutionAllowed');
    const createAt = body.search(/internalAgentService\.create\b/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(createAt);
  });

  it('runs the guard AFTER validation, so a malformed status cannot reach it', () => {
    const parseAt = body.indexOf('createInternalAgentSchema.safeParse');
    const guardAt = body.indexOf('checkExecutionAllowed');
    expect(parseAt).toBeGreaterThan(-1);
    expect(parseAt).toBeLessThan(guardAt);
  });

  it('the status transition still carries its own guard — both launch paths agree', () => {
    // Neither path may be the only enforced one. "Launch Now" hits create,
    // "Start Team" hits the status transition, which every surface reaches
    // through workspace-actions/team-status.ts.
    const teamStatus = fs.readFileSync(
      path.join(__dirname, '..', '..', 'workspace-actions', 'team-status.ts'),
      'utf8',
    );
    expect(router.split('checkExecutionAllowed(tenantId)').length - 1).toBeGreaterThanOrEqual(1);
    expect(teamStatus.split('checkExecutionAllowed(tenantId)').length - 1).toBeGreaterThanOrEqual(1);
  });
});

describe('the create schema still admits only known statuses', () => {
  it("status is an enum containing 'active' and 'draft'", () => {
    // The guard keys on the parsed value, so a schema that let an arbitrary
    // string through would let 'Active' or 'ACTIVE' slip past the comparison.
    const schema = /const createInternalAgentSchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(router);
    expect(schema).not.toBeNull();
    expect(schema![1]).toMatch(/status:\s*z\.enum\(\['draft', 'active', 'paused'\]\)/);
  });
});
