import type { ComponentProps, ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthContext } from '../src/contexts/AuthContext'
import { ToastProvider } from '../src/contexts/ToastProvider'

/**
 * The app context a story needs to render at all.
 *
 * Anything that reaches a data hook ends up in `useAuth`, and plenty of
 * components call `useToast` directly, so a story with only a query client
 * throws on render. That failure is invisible until somebody opens Storybook,
 * which is how several stories rotted: the component grew a hook and the story
 * was never touched again.
 *
 * The session is deliberately empty. With no tenant the connector queries stay
 * disabled, so stories render offline instead of reaching for a backend that is
 * not there.
 *
 * The router is outermost and unconditional. Any component deep enough to reach
 * a data hook is also likely to render a `Link` or call `useNavigate`, and
 * react-router throws on both without a router above them. A story should not
 * have to know which of the two it tripped over.
 */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const emptySession = {
  user: null,
  currentTenant: null,
  tenantLoading: false,
  loading: false,
  backendConnected: true,
  getIdToken: async () => null,
} as unknown as ComponentProps<typeof AuthContext.Provider>['value']

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthContext.Provider value={emptySession}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  )
}

/** Drop into a story's `decorators` array. */
export const withAppProviders = (Story: () => ReactNode) => (
  <AppProviders>
    <Story />
  </AppProviders>
)
