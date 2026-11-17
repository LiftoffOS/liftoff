import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useConnectorCatalog } from './useConnectorCatalog'
import { api } from '../services/api'

vi.mock('../services/api', () => ({
  api: {
    get: vi.fn(),
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'test-user' } }),
}))

const FIXTURE = {
  version: 'vtest',
  categoryLabels: {
    crm_sales: 'CRM & Sales',
    engineering: 'Engineering',
    accounting: 'Accounting',
  },
  connectors: [
    {
      type: 'github',
      displayName: 'GitHub',
      category: 'engineering',
      status: 'available',
      auth: { kind: 'static_oauth' },
      mcp: { kind: 'vendor_hosted' },
    },
    {
      type: 'quickbooks',
      displayName: 'QuickBooks Online',
      category: 'accounting',
      status: 'coming_soon',
      statusReason: 'Intuit OAuth app registration pending',
      auth: { kind: 'static_oauth' },
    },
    {
      type: 'trello',
      displayName: 'Trello',
      category: 'project_management',
      status: 'available',
      auth: { kind: 'api_key' },
    },
    {
      type: 'snowflake',
      displayName: 'Snowflake',
      category: 'data',
      status: 'available',
      auth: { kind: 'keypair' },
    },
  ],
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useConnectorCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue(FIXTURE)
  })

  it('fetches the catalog and exposes connectors + version + labels', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.connectors).toHaveLength(4)
    expect(result.current.version).toBe('vtest')
    expect(result.current.categoryLabels?.engineering).toBe('Engineering')
  })

  it('supportsConnection returns true for available, false for coming_soon', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.supportsConnection('github')).toBe(true)
    expect(result.current.supportsConnection('quickbooks')).toBe(false)
    expect(result.current.supportsConnection('unknown_connector')).toBe(false)
  })

  it('supportsOAuth matches static_oauth or dcr_oauth auth kinds', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.supportsOAuth('github')).toBe(true)
    expect(result.current.supportsOAuth('quickbooks')).toBe(true) // kind=static_oauth even though coming_soon
    expect(result.current.supportsOAuth('trello')).toBe(false)
    expect(result.current.supportsOAuth('snowflake')).toBe(false)
  })

  it('usesApiKey / usesKeypair / usesMCP route off the correct kinds', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.usesApiKey('trello')).toBe(true)
    expect(result.current.usesApiKey('github')).toBe(false)
    expect(result.current.usesKeypair('snowflake')).toBe(true)
    expect(result.current.usesKeypair('trello')).toBe(false)
    expect(result.current.usesMCP('github')).toBe(true) // has vendor_hosted mcp
    expect(result.current.usesMCP('snowflake')).toBe(false) // no mcp in fixture
  })

  it('labelForCategory returns the backend label, falling back to the raw key', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.labelForCategory('engineering')).toBe('Engineering')
    expect(result.current.labelForCategory('crm_sales')).toBe('CRM & Sales')
    // Missing from fixture → fallback to raw.
    expect(result.current.labelForCategory('nonexistent_category')).toBe('nonexistent_category')
  })

  it('byType provides fast lookup', async () => {
    const { result } = renderHook(() => useConnectorCatalog(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byType.get('github')?.displayName).toBe('GitHub')
    expect(result.current.byType.get('quickbooks')?.status).toBe('coming_soon')
    expect(result.current.byType.get('unknown')).toBeUndefined()
  })
})
