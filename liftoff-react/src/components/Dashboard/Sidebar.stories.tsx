// NOTE: Sidebar depends on:
//   - AuthContext (useAuth) — mocked below via AuthContext.Provider
//   - react-router (useNavigate, NavLink) — wrapped with MemoryRouter
//   - usePrefetchConnectors → useQueryClient — wrapped with QueryClientProvider
// All three providers are applied in the decorator so stories render without
// a live Firebase / backend connection.

import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import Sidebar from './Sidebar'
import { AuthContext, type AuthContextType } from '../../contexts/AuthContext'
import { mockAuthValue, storyTenants } from '../../../.storybook/authFixture'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function SidebarWithState(props: { defaultCollapsed?: boolean; isMobileOpen?: boolean; authOverride?: Partial<AuthContextType> }) {
  const [isCollapsed, setIsCollapsed] = useState(props.defaultCollapsed ?? false)
  const authValue = props.authOverride ? { ...mockAuthValue, ...props.authOverride } : mockAuthValue
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <div style={{ height: '100vh', display: 'flex' }}>
            <Sidebar
              isCollapsed={isCollapsed}
              onToggle={() => setIsCollapsed(c => !c)}
              isMobileOpen={props.isMobileOpen}
            />
          </div>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  )
}

const meta: Meta<typeof Sidebar> = {
  title: 'Components/Dashboard/Sidebar',
  component: Sidebar,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof Sidebar>

export const Expanded: Story = {
  render: () => <SidebarWithState defaultCollapsed={false} />,
}

export const Collapsed: Story = {
  render: () => <SidebarWithState defaultCollapsed={true} />,
}

export const MobileOpen: Story = {
  render: () => <SidebarWithState defaultCollapsed={false} isMobileOpen={true} />,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
}

export const SingleTenant: Story = {
  render: () => (
    <SidebarWithState
      defaultCollapsed={false}
      authOverride={{
        tenants: storyTenants.slice(0, 1),
      }}
    />
  ),
}
