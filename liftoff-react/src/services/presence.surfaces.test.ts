// Presence at the service boundary, for the two surfaces whose routers carry no
// agent id.
//
// The backend serves these as byte-identical copies of the agent-chat contract:
// the tenant travels in the POST body and in the DELETE query string, and the
// path has no agent segment. Getting either wrong is a 400 or a 404 that only
// shows up against a real backend, so the wire format is pinned here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const postMock = vi.fn()
const deleteMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => postMock(...args),
    put: vi.fn(),
    patch: vi.fn(),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  ApiError: class ApiError extends Error {},
}))

vi.mock('../config/firebase', () => ({ auth: { currentUser: null } }))

import { heartbeatLiftoffPresence, clearLiftoffPresence } from './liftoffChat'
import { heartbeatInsightsPresence, clearInsightsPresence } from './insightsChat'

const TENANT = '44444444-4444-4444-4444-444444444444'
const THREAD = '55555555-5555-5555-5555-555555555555'

const ROSTER = {
  viewers: [
    {
      accountId: 'acc-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      avatarUrl: null,
      typing: true,
    },
  ],
  liveTurnId: null,
  latestMessageAt: '2026-08-13T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  postMock.mockResolvedValue(ROSTER)
  deleteMock.mockResolvedValue(undefined)
})

describe.each([
  {
    surface: 'liftoff',
    base: '/api/liftoff',
    heartbeat: heartbeatLiftoffPresence,
    clear: clearLiftoffPresence,
  },
  {
    surface: 'insights',
    base: '/api/insights',
    heartbeat: heartbeatInsightsPresence,
    clear: clearInsightsPresence,
  },
])('$surface presence', ({ base, heartbeat, clear }) => {
  it('heartbeats with the tenant and state in the body', async () => {
    await heartbeat(TENANT, THREAD, 'typing')

    expect(postMock).toHaveBeenCalledWith(`${base}/threads/${THREAD}/presence`, {
      tenantId: TENANT,
      state: 'typing',
    })
  })

  it('returns the roster untouched, so one set of types covers every surface', async () => {
    await expect(heartbeat(TENANT, THREAD, 'viewing')).resolves.toEqual(ROSTER)
  })

  it('releases the seat with the tenant in the query string', async () => {
    await clear(TENANT, THREAD)

    expect(deleteMock).toHaveBeenCalledWith(
      `${base}/threads/${THREAD}/presence?tenantId=${TENANT}`,
    )
  })
})
