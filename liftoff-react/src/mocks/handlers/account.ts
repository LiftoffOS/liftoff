import { http, HttpResponse } from 'msw'

const mockAccount = {
  id: 'acc-mock-001',
  firebaseUid: 'mock-firebase-uid',
  firstName: 'Demo',
  lastName: 'User',
  email: 'demo@liftoff.dev',
  timezone: 'America/Los_Angeles',
  avatarUrl: null,
  stripeCustomerId: null,
  pendingEmail: null,
  preferences: {
    gettingStartedHidden: false,
  },
  accessGranted: true,
  accessReason: 'domain' as const,
  version: 1,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: new Date().toISOString(),
}

export const accountHandlers = [
  // Get current account
  http.get(`*/api/accounts/me`, () => {
    return HttpResponse.json(mockAccount)
  }),

  // Create account
  http.post(`*/api/accounts`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({
      ...mockAccount,
      ...body,
      id: `acc-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }),

  // Update account
  http.put(`*/api/accounts/me`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({
      ...mockAccount,
      ...body,
      updatedAt: new Date().toISOString(),
    })
  }),

  // Check email exists
  http.post(`*/api/accounts/email-check`, async ({ request }) => {
    const body = await request.json() as { email: string }
    // For mock purposes, pretend every address already exists (routes the
    // login form to sign-in) EXCEPT addresses containing "newuser", which are
    // treated as new so the signup -> /verify-email flow is walkable in mock
    // mode. Example: sign up with newuser@example.com to reach the email
    // verification interstitial.
    const isNew = body.email.toLowerCase().includes('newuser')
    return HttpResponse.json({ exists: body.email.includes('@') && !isNew })
  }),

  // Send signup verification email (no-op in mock mode so "Resend" succeeds)
  http.post(`*/api/accounts/me/send-verification`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Initiate email change
  http.post(`*/api/accounts/me/email`, async ({ request }) => {
    const body = await request.json() as { newEmail: string }
    return HttpResponse.json({
      ...mockAccount,
      pendingEmail: body.newEmail,
      updatedAt: new Date().toISOString(),
    })
  }),

  // Cancel email change
  http.delete(`*/api/accounts/me/email`, () => {
    return HttpResponse.json({
      ...mockAccount,
      pendingEmail: null,
      updatedAt: new Date().toISOString(),
    })
  }),
]
