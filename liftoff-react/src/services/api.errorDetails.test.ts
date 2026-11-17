// A rejected request has to carry WHICH field it was rejected on.
//
// The server sends `{ error: 'Validation failed', details: [{ path, code,
// message }] }`. The client dropped `details`, so a create rejected on
// `workflowSteps[1].description` reached the person as a bare "Validation
// failed" and reached telemetry as nothing at all. Naming the field is what turns
// "our own generator violates our own contract" from a support conversation into
// a rate somebody can watch.

import { describe, it, expect } from 'vitest'
import { ApiError, firstInvalidField } from './api'

describe('ApiError', () => {
  it('carries the server details alongside status and message', () => {
    const details = [{ path: 'workflowSteps[1].description', code: 'too_big' }]
    const error = new ApiError('Validation failed', 400, details)

    expect(error.status).toBe(400)
    expect(error.message).toBe('Validation failed')
    expect(error.details).toBe(details)
  })

  it('leaves details absent when the server sent none', () => {
    const error = new ApiError('HTTP 500', 500)
    expect(error.details).toBeUndefined()
  })
})

describe('firstInvalidField', () => {
  it('names the field from a string path', () => {
    const error = new ApiError('Validation failed', 400, [
      { path: 'workflowSteps[1].description', code: 'too_big', message: 'too long' },
    ])

    expect(firstInvalidField(error)).toBe('workflowSteps[1].description')
  })

  it('joins a zod-shaped array path', () => {
    // zod issues carry path as segments; both shapes reach this code depending on
    // which handler formatted the response.
    const error = new ApiError('Validation failed', 400, [
      { path: ['workflowSteps', 1, 'description'], code: 'too_big' },
    ])

    expect(firstInvalidField(error)).toBe('workflowSteps.1.description')
  })

  it('skips entries with no usable path', () => {
    const error = new ApiError('Validation failed', 400, [
      { code: 'custom' },
      { path: '' },
      { path: 'triggerConfig.cronExpr' },
    ])

    expect(firstInvalidField(error)).toBe('triggerConfig.cronExpr')
  })

  it('returns undefined for the errors that are not field rejections', () => {
    expect(firstInvalidField(new ApiError('Server error', 500))).toBeUndefined()
    expect(firstInvalidField(new ApiError('Bad', 400, 'not an array'))).toBeUndefined()
    expect(firstInvalidField(new Error('network down'))).toBeUndefined()
    expect(firstInvalidField(undefined)).toBeUndefined()
    expect(firstInvalidField(null)).toBeUndefined()
  })
})
