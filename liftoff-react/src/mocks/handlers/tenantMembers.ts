import { http, HttpResponse } from 'msw'

// A workspace that finished setting itself up, which is what the rest of these
// fixtures describe: teams already built, a queue with work in it, connectors
// bound. Without onboardingCompletedAt this same row said the opposite, and
// DashboardOnboardingGate reads an owner with no completion and no path as
// somebody who never started — so every /dashboard URL redirected to
// /onboarding, and the wizard could not finish either, because the PATCH that
// records progress is mocked as an echo and the next read of this row returns
// these same fields. Run `npm run dev:onboarding` to work on the wizard.
const mockTenant = {
  id: 'tenant-mock-001',
  accountId: 'acc-mock-001',
  name: 'Demo Workspace',
  status: 'active',
  gcpProjectId: 'demo',
  databaseName: 'demo_db',
  migrationStatus: 'complete',
  hasCreatedInternalAgent: true,
  onboardingPath: 'A',
  onboardingStepId: 'invite',
  onboardingCompletedAt: '2024-01-02T00:00:00Z',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: new Date().toISOString(),
  role: 'owner',
}

export const tenantMembersHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes

  // Get my tenant memberships (critical for app to work)
  http.get(`*/api/tenant-members/my-memberships`, () => {
    return HttpResponse.json([mockTenant])
  }),

  // Get invitation by token (must be before :tenantId route)
  http.get(`*/api/tenant-members/invitations/:token`, ({ params }) => {
    if (params.token === 'expired-token') {
      return HttpResponse.json({ status: 'expired', tenantName: 'Test Workspace' })
    }
    if (params.token === 'revoked-token') {
      return HttpResponse.json({ status: 'revoked' })
    }
    return HttpResponse.json({
      id: 'inv-1',
      tenantId: 'tenant-1',
      tenantName: 'Test Workspace',
      email: 'invitee@example.com',
      role: 'member',
      status: 'pending',
      invitedBy: { id: 'acc-1', firstName: 'John', lastName: 'Doe' },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
  }),

  // Accept invitation (must be before :tenantId route)
  http.post(`*/api/tenant-members/accept-invite`, () => {
    return HttpResponse.json({ tenantId: 'tenant-mock-001' })
  }),

  // Get tenant members
  http.get(`*/api/tenant-members/:tenantId`, () => {
    return HttpResponse.json({
      members: [
        { id: '1', accountId: 'acc-1', account: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' }, role: 'owner', joinedAt: '2024-01-01' },
        { id: '2', accountId: 'acc-2', account: { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' }, role: 'admin', joinedAt: '2024-01-02' },
      ],
      nextCursor: null,
      hasMore: false
    })
  }),

  http.post(`*/api/tenant-members/:tenantId/invite`, async ({ request }) => {
    const body = await request.json() as { email: string; role: string }
    return HttpResponse.json({
      id: 'inv-1',
      email: body.email,
      role: body.role,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
  }),

  http.delete(`*/api/tenant-members/:tenantId/members/:accountId`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Update member role
  http.patch(`*/api/tenant-members/:tenantId/members/:accountId/role`, async ({ params, request }) => {
    const body = await request.json() as { role: string }
    return HttpResponse.json({
      id: params.accountId,
      accountId: params.accountId,
      account: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
      role: body.role,
      joinedAt: '2024-01-01',
    })
  }),

  http.get(`*/api/tenant-members/:tenantId/invitations`, () => {
    return HttpResponse.json({
      invitations: [
        {
          id: 'inv-1',
          tenantId: 'tenant-1',
          tenantName: 'Test Workspace',
          email: 'pending@example.com',
          role: 'member',
          status: 'pending',
          invitedBy: { id: 'acc-1', firstName: 'John', lastName: 'Doe' },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }
      ],
      nextCursor: null,
      hasMore: false
    })
  }),

  http.delete(`*/api/tenant-members/:tenantId/invitations/:invitationId`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Update invitation role
  http.patch(`*/api/tenant-members/:tenantId/invitations/:invitationId/role`, async ({ params, request }) => {
    const body = await request.json() as { role: string }
    return HttpResponse.json({
      id: params.invitationId,
      tenantId: params.tenantId,
      tenantName: 'Test Workspace',
      email: 'pending@example.com',
      role: body.role,
      status: 'pending',
      invitedBy: { id: 'acc-1', firstName: 'John', lastName: 'Doe' },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
  }),

  // Get audit entries
  http.get(`*/api/tenant-members/:tenantId/audit`, ({ params }) => {
    return HttpResponse.json({
      entries: [
        {
          id: 'audit-1',
          tenantId: params.tenantId,
          accountId: 'acc-1',
          action: 'member.role.updated',
          actorId: 'acc-owner',
          previousState: { role: 'member' },
          newState: { role: 'admin' },
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          id: 'audit-2',
          tenantId: params.tenantId,
          accountId: 'acc-2',
          action: 'member.invited',
          actorId: 'acc-owner',
          previousState: null,
          newState: { email: 'newuser@example.com', role: 'member' },
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
        {
          id: 'audit-3',
          tenantId: params.tenantId,
          accountId: null,
          action: 'settings.updated',
          actorId: 'acc-owner',
          previousState: { autonomy: 'supervised' },
          newState: { autonomy: 'balanced' },
          createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        },
      ],
      nextCursor: null,
      hasMore: false,
    })
  }),
]
