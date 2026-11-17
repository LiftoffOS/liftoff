// ApiError must carry the backend's machine-readable `code`.
//
// Regression guard. The client previously discarded `code` while building the
// message string, and callers branched on an axios-shaped
// `err.response.data.code` that this client never produces — so every branch
// was dead and every failure fell through to a generic toast. Live callers
// depending on the code reaching them: NICKNAME_CONFLICT on the team-update
// save, and the oversight decision codes on ReviewQueuePage.

import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/mocks/server'
import { api, ApiError, apiErrorCode } from './api'

describe('ApiError code propagation', () => {
  it('carries `code` and `status` off a JSON error body', async () => {
    server.use(
      http.put('*/api/test-code', () =>
        HttpResponse.json(
          { error: 'This nickname is already taken.', code: 'NICKNAME_CONFLICT' },
          { status: 400 },
        ),
      ),
    )

    const err = await api.put('/api/test-code', {}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('NICKNAME_CONFLICT')
    expect((err as ApiError).status).toBe(400)
    // The prose still reaches the message, so a codeless caller is unaffected.
    expect((err as ApiError).message).toBe('This nickname is already taken.')
  })

  it('leaves `code` undefined when the body has none', async () => {
    server.use(
      http.put('*/api/test-nocode', () =>
        HttpResponse.json({ message: 'Boom' }, { status: 500 }),
      ),
    )

    const err = await api.put('/api/test-nocode', {}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBeUndefined()
  })

  it('ignores a non-string code rather than passing junk to callers', async () => {
    server.use(
      http.put('*/api/test-badcode', () =>
        HttpResponse.json({ message: 'Boom', code: { nested: true } }, { status: 400 }),
      ),
    )

    const err = await api.put('/api/test-badcode', {}).catch((e: unknown) => e)

    expect((err as ApiError).code).toBeUndefined()
  })
})

describe('apiErrorCode', () => {
  // `code` is the FOURTH arg: `details` shipped third and its callers are
  // pinned to that position.
  it('reads the code off an ApiError', () => {
    expect(apiErrorCode(new ApiError('nope', 400, undefined, 'NICKNAME_CONFLICT'))).toBe('NICKNAME_CONFLICT')
  })

  it('carries code and details independently', () => {
    const err = new ApiError('Validation failed', 400, [{ path: 'role' }], 'SOME_CODE')
    expect(err.code).toBe('SOME_CODE')
    expect(err.details).toEqual([{ path: 'role' }])
  })

  // Mutation callbacks receive `unknown`; a network failure is a plain Error.
  it('returns undefined for anything that is not an ApiError', () => {
    expect(apiErrorCode(new Error('network down'))).toBeUndefined()
    expect(apiErrorCode('a string')).toBeUndefined()
    expect(apiErrorCode(undefined)).toBeUndefined()
  })
})
