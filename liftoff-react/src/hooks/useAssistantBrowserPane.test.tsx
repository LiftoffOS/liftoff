import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const ensureSessionMock = vi.fn()
const getActiveSessionMock = vi.fn()
vi.mock('../services/browserSessions', () => ({
  ensureSession: (...a: unknown[]) => ensureSessionMock(...a),
  getActiveSession: (...a: unknown[]) => getActiveSessionMock(...a),
  endSession: vi.fn(),
  goto: vi.fn(),
}))
vi.mock('./useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1' } }) }))
vi.mock('./usePlatformBrowser', () => ({ usePlatformBrowser: () => ({ isAvailable: true, isPending: false }) }))
vi.mock('./useConnectors', () => ({ useConnectors: () => ({ data: [] }) }))
vi.mock('../config/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'test-token' } },
}))

import { useAssistantBrowserPane } from './useAssistantBrowserPane'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}) as Promise<Response>)
  getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
  ensureSessionMock.mockResolvedValue({ session: { id: 's1' }, wasNewlyCreated: true })
})

describe('opening the pane before the first message', () => {
  // The defect: the pane was pressed on a fresh conversation, a thread was
  // minted, and the ensure fired on the hook instance built for a null thread,
  // so the request went to /threads/null/... and the pane said it could not
  // start a browser. The ensure has to run on the render that carries the
  // minted thread id.
  it('mints a thread, then ensures against THAT thread and never against null', async () => {
    const ensureThread = vi.fn(async () => 'thread-new')
    let threadId: string | null = null
    const { result, rerender } = renderHook(
      () => useAssistantBrowserPane({
        surface: 'team_plan', tenantId: 'tenant-1', threadId, ensureThread, assistantName: 'the CAIO',
      }),
      { wrapper: makeWrapper() },
    )

    await act(async () => { await result.current.toggle() })
    expect(ensureThread).toHaveBeenCalledTimes(1)
    expect(ensureSessionMock).not.toHaveBeenCalled()

    // The page stores the minted id and re-renders the hook with it, the way
    // ensureThread on every assistant page does with setCurrentThreadId.
    threadId = 'thread-new'
    rerender()

    await waitFor(() => expect(ensureSessionMock).toHaveBeenCalledTimes(1))
    expect(ensureSessionMock.mock.calls[0][1]).toBe('thread-new')
    expect(ensureSessionMock.mock.calls[0][3]).toBe('team_plan')
  })

  it('ensures at once when the thread already exists', async () => {
    const ensureThread = vi.fn(async () => 'never')
    const { result } = renderHook(
      () => useAssistantBrowserPane({
        surface: 'liftoff', tenantId: 'tenant-1', threadId: 'thread-1', ensureThread, assistantName: 'Liftoff',
      }),
      { wrapper: makeWrapper() },
    )
    await act(async () => { await result.current.toggle() })
    expect(ensureThread).not.toHaveBeenCalled()
    await waitFor(() => expect(ensureSessionMock).toHaveBeenCalledTimes(1))
    expect(ensureSessionMock.mock.calls[0][1]).toBe('thread-1')
  })

  it('does nothing further when the thread could not be minted', async () => {
    const ensureThread = vi.fn(async () => null)
    const { result, rerender } = renderHook(
      () => useAssistantBrowserPane({
        surface: 'insights', tenantId: 'tenant-1', threadId: null, ensureThread, assistantName: 'the Insights Manager',
      }),
      { wrapper: makeWrapper() },
    )
    await act(async () => { await result.current.toggle() })
    rerender()
    expect(ensureSessionMock).not.toHaveBeenCalled()
  })
})
