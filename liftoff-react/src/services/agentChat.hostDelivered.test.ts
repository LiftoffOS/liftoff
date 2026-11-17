import { describe, it, expect, vi } from 'vitest'
import { dispatchSseEvent } from './agentChat'

// The last hop of a side channel that had no producer.
//
// The runtime lifts declared fields off a tool result so the model never holds
// them, and until now it dropped the values on the floor — so the component
// built to show them had nothing to show and no path to be shown on. These
// assert the browser end of that path: the frame arrives, the fields reach the
// surface, and a malformed entry is refused rather than rendered.

describe('host_delivered', () => {
  it('hands the fields to the surface', () => {
    const onHostDelivered = vi.fn()
    dispatchSseEvent(
      'host_delivered',
      { tool: 'drive__get_file', fields: [{ path: 'data.downloadUrl', value: 'https://x.test/a' }] },
      { onHostDelivered },
    )
    expect(onHostDelivered).toHaveBeenCalledWith({
      tool: 'drive__get_file',
      fields: [{ path: 'data.downloadUrl', value: 'https://x.test/a' }],
    })
  })

  it('drops a field with no path rather than rendering a bare value', () => {
    // An unlabelled value beside a tool call tells the reader nothing they can
    // act on, and these arrive from a connector.
    const onHostDelivered = vi.fn()
    dispatchSseEvent('host_delivered', { tool: 't', fields: [{ value: 'x' }] }, { onHostDelivered })
    expect(onHostDelivered).not.toHaveBeenCalled()
  })

  it('does not fire when the frame carries no fields at all', () => {
    const onHostDelivered = vi.fn()
    dispatchSseEvent('host_delivered', { tool: 't' }, { onHostDelivered })
    expect(onHostDelivered).not.toHaveBeenCalled()
  })

  it('does not throw when nothing is listening', () => {
    expect(() =>
      dispatchSseEvent('host_delivered', { tool: 't', fields: [{ path: 'p', value: 1 }] }, {}),
    ).not.toThrow()
  })
})
