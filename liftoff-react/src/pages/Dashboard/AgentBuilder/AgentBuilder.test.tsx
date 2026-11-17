import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import AgentBuilder from './AgentBuilder'

// Mock react-router hooks
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  }
})

// Mock the tenant hook (component uses useTenant, not useAuth)
vi.mock('../../../hooks/useTenant', () => ({
  useTenant: () => ({
    currentTenant: { id: 'test-tenant-id' },
  }),
}))

// Mock the create internal agent hook
vi.mock('../../../hooks/useInternalAgents', () => ({
  useCreateInternalAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useInternalAgents: () => ({
    data: { pages: [{ internalAgents: [] }] },
  }),
}))

vi.mock('../../../hooks/useKnowledge', () => ({
  useKnowledgeItems: () => ({ data: [] }),
}))

// Mock toast context
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}))

// Mock distill service
vi.mock('../../../services/internalAgents', () => ({
  distillInternalAgentStream: vi.fn(),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

describe('AgentBuilder', () => {
  it('renders the first step', () => {
    render(<AgentBuilder />, { wrapper: createWrapper() })

    // First step asks about role
    expect(screen.getByText(/who do you need on your team/i)).toBeInTheDocument()
  })

  it('has a role input field', () => {
    render(<AgentBuilder />, { wrapper: createWrapper() })

    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
  })

  it('has a continue button', () => {
    render(<AgentBuilder />, { wrapper: createWrapper() })

    const button = screen.getByRole('button', { name: /continue/i })
    expect(button).toBeInTheDocument()
  })

  it('shows back button on first step with Go back label', () => {
    render(<AgentBuilder />, { wrapper: createWrapper() })

    // Back button is visible on every step, this one included.
    const backButton = screen.getByRole('button', { name: /go back/i })
    expect(backButton).toBeInTheDocument()
  })
})
