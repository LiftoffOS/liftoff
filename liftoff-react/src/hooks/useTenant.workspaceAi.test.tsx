// useWorkspaceAiVendor / useUpdateWorkspaceAiVendor — react-query behavior:
// the query stays disabled until a tenant id exists, fetches the committed
// server value, and a successful mutation writes the query cache so the card
// reflects the new selection without a refetch.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const getVendorMock = vi.fn()
const updateVendorMock = vi.fn()

vi.mock('../services/tenants', () => ({
  getWorkspaceAiVendor: (...args: unknown[]) => getVendorMock(...args),
  updateWorkspaceAiVendor: (...args: unknown[]) => updateVendorMock(...args),
  renameTenant: vi.fn(),
  updateTenant: vi.fn(),
}))

// useRenameTenant/useUpdateTenant pull AuthContext; the workspace AI hooks do
// not, but the module imports it — stub the hook the module needs.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ refreshTenants: vi.fn() }),
}))
vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

import { useWorkspaceAiVendor, useUpdateWorkspaceAiVendor } from './useTenant'

const TENANT = '55555555-5555-5555-5555-555555555555'

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

beforeEach(() => {
  getVendorMock.mockReset()
  updateVendorMock.mockReset()
})

describe('useWorkspaceAiVendor', () => {
  it('does not fetch until a tenant id exists', async () => {
    const { wrapper } = makeWrapper()
    renderHook(() => useWorkspaceAiVendor(undefined), { wrapper })
    await new Promise((r) => setTimeout(r, 10))
    expect(getVendorMock).not.toHaveBeenCalled()
  })

  it('fetches the committed server value for the tenant', async () => {
    getVendorMock.mockResolvedValueOnce('kimi')
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useWorkspaceAiVendor(TENANT), { wrapper })
    await waitFor(() => expect(result.current.data).toBe('kimi'))
    expect(getVendorMock).toHaveBeenCalledWith(TENANT)
  })
})

describe('useUpdateWorkspaceAiVendor', () => {
  it('calls the service and writes the query cache on success', async () => {
    updateVendorMock.mockResolvedValueOnce({ id: TENANT, name: 'Acme' })
    const { queryClient, wrapper } = makeWrapper()
    queryClient.setQueryData(['workspace-ai-vendor', TENANT], 'default')

    const { result } = renderHook(() => useUpdateWorkspaceAiVendor(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ tenantId: TENANT, vendor: 'glm' })
    })

    expect(updateVendorMock).toHaveBeenCalledWith(TENANT, 'glm')
    expect(queryClient.getQueryData(['workspace-ai-vendor', TENANT])).toBe('glm')
  })

  it('propagates a failure and leaves the cache untouched', async () => {
    updateVendorMock.mockRejectedValueOnce(new Error('403'))
    const { queryClient, wrapper } = makeWrapper()
    queryClient.setQueryData(['workspace-ai-vendor', TENANT], 'default')

    const { result } = renderHook(() => useUpdateWorkspaceAiVendor(), { wrapper })
    await expect(
      act(async () => {
        await result.current.mutateAsync({ tenantId: TENANT, vendor: 'openai' })
      }),
    ).rejects.toThrow('403')

    expect(queryClient.getQueryData(['workspace-ai-vendor', TENANT])).toBe('default')
  })
})
