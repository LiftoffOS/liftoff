import { describe, it, expect, vi } from 'vitest'
import { dispatchSseEvent, type StreamLiftoffChatCallbacks } from './liftoffChat'

/** Every callback stubbed, so a test can assert what did NOT fire as well as
 *  what did. */
function callbacks() {
  return {
    onThinking: vi.fn(),
    onToolCall: vi.fn(),
    onTextDelta: vi.fn(),
    onContentBlock: vi.fn(),
    onDelegationStarted: vi.fn(),
    onDelegationPaused: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onInterruptDelivered: vi.fn(),
  } satisfies Required<StreamLiftoffChatCallbacks>
}

describe('liftoff SSE dispatch', () => {
  it('routes thinking', () => {
    const cb = callbacks()
    dispatchSseEvent('thinking', {}, cb)
    expect(cb.onThinking).toHaveBeenCalledOnce()
  })

  it('routes tool_call with the tool name and the phrase a person reads', () => {
    const cb = callbacks()
    dispatchSseEvent('tool_call', { tool: 'knowledge_search', label: 'Searching the knowledge base' }, cb)
    expect(cb.onToolCall).toHaveBeenCalledWith('knowledge_search', 'Searching the knowledge base')
  })

  it('routes tool_call with no label when the service sent none', () => {
    // A service one version behind. The name still routes, and the phrase is
    // decided downstream rather than derived from it.
    const cb = callbacks()
    dispatchSseEvent('tool_call', { tool: 'search' }, cb)
    expect(cb.onToolCall).toHaveBeenCalledWith('search', undefined)
  })

  it('routes text_delta with the text', () => {
    const cb = callbacks()
    dispatchSseEvent('text_delta', { text: 'hello' }, cb)
    expect(cb.onTextDelta).toHaveBeenCalledWith('hello')
  })

  // Liftoff draws no charts of its own. A block on this stream was relayed from
  // the colleague handling the turn, and dropping it was what left an org chart
  // persisted but never drawn.
  it('routes content_block with the block', () => {
    const cb = callbacks()
    const block = { type: 'org_chart', nodes: [], edges: [] }
    dispatchSseEvent('content_block', { block }, cb)
    expect(cb.onContentBlock).toHaveBeenCalledWith(block)
  })

  it('ignores a content_block whose block is not an object', () => {
    const cb = callbacks()
    dispatchSseEvent('content_block', { block: 'org_chart' }, cb)
    expect(cb.onContentBlock).not.toHaveBeenCalled()
  })

  it('ignores a content_block with no block at all', () => {
    const cb = callbacks()
    dispatchSseEvent('content_block', {}, cb)
    expect(cb.onContentBlock).not.toHaveBeenCalled()
  })

  // Who is speaking, delivered while the reply is still arriving rather than
  // only on the persisted message at the end of it. As the contributor the
  // stored reply will carry, through the parser every surface shares.
  it('routes delegation_started with the identity and the label', () => {
    const cb = callbacks()
    dispatchSseEvent(
      'delegation_started',
      { author: 'insights', authorLabel: 'Insights Manager' },
      cb,
    )
    expect(cb.onDelegationStarted).toHaveBeenCalledWith({
      id: 'insights',
      label: 'Insights Manager',
    })
  })

  it('ignores a delegation_started with no label to show', () => {
    const cb = callbacks()
    dispatchSseEvent('delegation_started', { author: 'insights' }, cb)
    expect(cb.onDelegationStarted).not.toHaveBeenCalled()
  })

  it('ignores a delegation_started with no identity behind the label', () => {
    const cb = callbacks()
    dispatchSseEvent('delegation_started', { authorLabel: 'Insights Manager' }, cb)
    expect(cb.onDelegationStarted).not.toHaveBeenCalled()
  })

  // A pause is not a failure. It used to arrive on the error channel, which put
  // the person's message back in the composer as though the send had failed;
  // the whole point of this frame is that it never touches onError.
  it('routes delegation_paused with the destination it carries', () => {
    const cb = callbacks()
    dispatchSseEvent(
      'delegation_paused',
      {
        author: 'agent-1',
        authorLabel: 'Support Team',
        delegateThreadId: 'thread-9',
        reason: 'Support Team is waiting on an approval before it can continue.',
      },
      cb,
    )
    expect(cb.onDelegationPaused).toHaveBeenCalledWith({
      author: 'agent-1',
      authorLabel: 'Support Team',
      delegateThreadId: 'thread-9',
      reason: 'Support Team is waiting on an approval before it can continue.',
    })
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onComplete).not.toHaveBeenCalled()
  })

  it('still reports a pause whose destination could not be resolved', () => {
    // Swallowing the frame would leave the composer streaming forever, so a
    // pause with nowhere to send the person is still terminal.
    const cb = callbacks()
    dispatchSseEvent(
      'delegation_paused',
      { author: 'agent-1', authorLabel: 'Support Team', reason: 'Waiting.' },
      cb,
    )
    expect(cb.onDelegationPaused).toHaveBeenCalledWith({
      author: 'agent-1',
      authorLabel: 'Support Team',
      delegateThreadId: null,
      reason: 'Waiting.',
    })
  })

  it('routes interrupt_delivered', () => {
    const cb = callbacks()
    dispatchSseEvent('interrupt_delivered', {}, cb)
    expect(cb.onInterruptDelivered).toHaveBeenCalledOnce()
  })

  it('hands the persisted message to complete', () => {
    const cb = callbacks()
    const message = { id: 'm1', threadId: 't1', role: 'assistant', content: 'hi' }
    dispatchSseEvent('complete', { message }, cb)
    expect(cb.onComplete).toHaveBeenCalledWith(message)
  })

  it('still completes with null when the turn was stopped before it spoke', () => {
    // Nothing was persisted, so there is no message. The handler must fire
    // anyway or the composer streams forever.
    const cb = callbacks()
    dispatchSseEvent('complete', {}, cb)
    expect(cb.onComplete).toHaveBeenCalledWith(null)
  })

  it('routes error with its code and message', () => {
    const cb = callbacks()
    dispatchSseEvent('error', { code: 'MAX_ITERATIONS', message: 'gave up' }, cb)
    expect(cb.onError).toHaveBeenCalledWith({ code: 'MAX_ITERATIONS', message: 'gave up' })
  })

  it('falls back to a usable error when the payload omits both fields', () => {
    const cb = callbacks()
    dispatchSseEvent('error', {}, cb)
    expect(cb.onError).toHaveBeenCalledWith({ code: 'UNKNOWN', message: 'Unknown error' })
  })

  it('ignores a tool_call whose tool is not a string', () => {
    const cb = callbacks()
    dispatchSseEvent('tool_call', { tool: 42 }, cb)
    expect(cb.onToolCall).not.toHaveBeenCalled()
  })

  it('ignores a text_delta whose text is not a string', () => {
    const cb = callbacks()
    dispatchSseEvent('text_delta', { text: null }, cb)
    expect(cb.onTextDelta).not.toHaveBeenCalled()
  })

  it('ignores an event name it does not know', () => {
    const cb = callbacks()
    expect(() => dispatchSseEvent('hitl_required', { approvalId: 'a1' }, cb)).not.toThrow()
    for (const fn of Object.values(cb)) expect(fn).not.toHaveBeenCalled()
  })

  it('tolerates a surface that supplies no callbacks at all', () => {
    expect(() => dispatchSseEvent('thinking', {}, {})).not.toThrow()
    expect(() => dispatchSseEvent('complete', {}, {})).not.toThrow()
  })
})
