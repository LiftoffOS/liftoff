// MCP OAuth consent (the /oauth/consent page, opened by a coding tool).
//
// The request id picks the scenario so every state of the page is walkable in
// mock mode:
//   ?request_id=demo     a live request: the workspace picker, Approve, Deny
//   ?request_id=setup    the person is a member of one workspace and owns
//                        another whose onboarding is not finished: both are
//                        listed, the unfinished one marked; choosing it
//                        offers Continue Setup, which parks the request and
//                        goes to onboarding
//   ?request_id=newuser  the person owns only an unfinished workspace: the
//                        same picker with that one row selected, no Approve
//   ?request_id=expired  410, the expired state
//   anything else        404, the invalid state
//
// The device flow's /activate page uses the code the same way:
//   ?code=DMCD-XKPT   a live code from Codex: the consent, Approve, Deny
//   ?code=GMNC-LWRK   the same, registered by Gemini CLI
//   ?code=MSPR-SNLG   a client the backend does not know (generic mark)
//   ?code=STPW-RKSP   the setup scenario (an unfinished workspace of one's own)
//   ?code=XPRD-CDXK   410, the expired state
//   anything else     404, the not-recognized state; no ?code shows the entry
//
// The memberships handler here runs ahead of the general one (handlers.ts
// lists these first) and answers only on the consent page for the two setup
// scenarios; every other request falls through.

import { http, HttpResponse } from 'msw'

const parked = new Set<string>()

function requestFor() {
  return {
    clientName: 'Claude Code',
    clientSlug: 'claude-code',
    clientLabel: 'Claude Code',
    redirectHost: 'localhost',
    scope: 'mcp',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }
}

function scenario(): string | null {
  const params = new URLSearchParams(window.location.search)
  if (window.location.pathname === '/activate') {
    return params.get('code') === 'STPW-RKSP' ? 'setup' : null
  }
  if (window.location.pathname !== '/oauth/consent') return null
  const id = params.get('request_id')
  return id === 'setup' || id === 'newuser' ? id : null
}

const DEVICE_CODES: Record<string, { clientName: string; clientSlug: string | null; clientLabel: string }> = {
  'DMCD-XKPT': { clientName: 'Codex', clientSlug: 'codex', clientLabel: 'Codex' },
  'GMNC-LWRK': { clientName: 'Gemini CLI MCP Client', clientSlug: 'gemini-cli', clientLabel: 'Gemini CLI' },
  'MSPR-SNLG': { clientName: 'Muse personal agent', clientSlug: null, clientLabel: 'Muse personal agent' },
  'STPW-RKSP': { clientName: 'Claude Code', clientSlug: 'claude-code', clientLabel: 'Claude Code' },
}

const UNFINISHED_WORKSPACE = {
  id: 'tenant-setup',
  accountId: 'acc-1',
  name: 'My Workspace',
  tier: 'starter',
  hostingMode: 'shared',
  status: 'active',
  onboardingPath: 'A',
  onboardingStepId: 'workspace_name',
  onboardingCompletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  role: 'owner',
}

const READY_WORKSPACE = {
  ...UNFINISHED_WORKSPACE,
  id: 'tenant-ready',
  name: 'Northwind Labs',
  onboardingStepId: 'invite',
  onboardingCompletedAt: '2026-01-02T00:00:00Z',
  role: 'member',
}

export const oauthConsentHandlers = [
  // The setup scenarios' memberships. Once parked, the unfinished workspace
  // reads as set up, the way it does after onboarding.
  http.get('*/api/tenant-members/my-memberships', () => {
    const which = scenario()
    if (!which) return undefined
    const own = parked.has(which) ? { ...UNFINISHED_WORKSPACE, onboardingCompletedAt: new Date().toISOString() } : UNFINISHED_WORKSPACE
    return HttpResponse.json(which === 'setup' ? [READY_WORKSPACE, own] : [own])
  }),

  http.get('*/api/oauth/consent/:requestId', ({ params }) => {
    const requestId = String(params.requestId)
    if (requestId === 'expired') return HttpResponse.json({ error: 'request_expired' }, { status: 410 })
    if (!['demo', 'setup', 'newuser'].includes(requestId)) return HttpResponse.json({ error: 'request_not_found' }, { status: 404 })
    return HttpResponse.json(requestFor())
  }),

  http.post('*/api/oauth/consent/park', async ({ request }) => {
    const body = await request.json() as { requestId: string; tenantId: string }
    if (body.requestId === 'expired') return HttpResponse.json({ error: 'request_expired' }, { status: 410 })
    parked.add(body.requestId)
    return HttpResponse.json({ parked: true, onboardingUrl: '/onboarding' })
  }),

  http.post('*/api/oauth/consent', async ({ request }) => {
    const body = await request.json() as { requestId: string; tenantId?: string; approve: boolean }
    if (body.requestId === 'expired') return HttpResponse.json({ error: 'request_expired' }, { status: 410 })
    if (!body.approve) return HttpResponse.json({ redirectTo: 'http://localhost:5173/?consent=denied' })
    return HttpResponse.json({ redirectTo: 'http://localhost:5173/?consent=approved' })
  }),

  // ── Device flow ──────────────────────────────────────────────────────
  http.post('*/api/oauth/device/lookup', async ({ request }) => {
    const { userCode } = await request.json() as { userCode: string }
    if (userCode === 'XPRD-CDXK') return HttpResponse.json({ error: 'code_expired' }, { status: 410 })
    const client = DEVICE_CODES[userCode]
    if (!client) return HttpResponse.json({ error: 'code_not_found' }, { status: 404 })
    return HttpResponse.json({ ...client, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })
  }),

  http.post('*/api/oauth/device', async ({ request }) => {
    const body = await request.json() as { userCode: string; tenantId?: string; approve: boolean }
    if (body.userCode === 'XPRD-CDXK') return HttpResponse.json({ error: 'code_expired' }, { status: 410 })
    if (!DEVICE_CODES[body.userCode]) return HttpResponse.json({ error: 'code_not_found' }, { status: 404 })
    if (!body.approve) return HttpResponse.json({ approved: false })
    return HttpResponse.json({ approved: true, workspaceName: body.tenantId === 'tenant-ready' ? 'Northwind Labs' : undefined })
  }),
]
