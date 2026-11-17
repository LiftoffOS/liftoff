import { useState, type ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthContext } from '../contexts/AuthContext'
import { ToastProvider } from '../contexts/ToastProvider'
import IntegrationsSelector, { type SelectedIntegration } from './IntegrationsSelector'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
})

/** This component reaches useIntegrations, which reads AuthContext, and calls
 *  useToast directly, so a query client alone left the story throwing on render.
 *  An empty session is deliberate: with no tenant the connector queries stay
 *  disabled, so the story renders offline rather than reaching for a backend
 *  that is not there. */
const mockAuthValue = {
  user: null,
  currentTenant: null,
  tenantLoading: false,
  loading: false,
  backendConnected: true,
  getIdToken: async () => null,
} as unknown as ComponentProps<typeof AuthContext.Provider>['value']

const meta: Meta<typeof IntegrationsSelector> = {
  title: 'Forms/IntegrationsSelector',
  component: IntegrationsSelector,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <AuthContext.Provider value={mockAuthValue}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Story />
          </ToastProvider>
        </QueryClientProvider>
      </AuthContext.Provider>
    ),
  ],
  argTypes: {
    titleAs: {
      control: 'select',
      options: ['h1', 'h2', 'h3'],
    },
    chipsLimit: { control: 'number' },
  },
}

export default meta
type Story = StoryObj<typeof IntegrationsSelector>

export const Default: Story = {
  render: function Render(args) {
    const [selected, setSelected] = useState<SelectedIntegration[]>([])
    return (
      <div style={{ maxWidth: '800px' }}>
        <IntegrationsSelector {...args} selected={selected} onChange={setSelected} />
      </div>
    )
  },
}

export const WithSelection: Story = {
  render: function Render(args) {
    const [selected, setSelected] = useState<SelectedIntegration[]>([
      { id: 'salesforce', name: 'Salesforce', type: 'crm', selectedObjects: [] },
    ])
    return (
      <div style={{ maxWidth: '800px' }}>
        <IntegrationsSelector {...args} selected={selected} onChange={setSelected} />
      </div>
    )
  },
}

export const CustomTitle: Story = {
  render: function Render(args) {
    const [selected, setSelected] = useState<SelectedIntegration[]>([])
    return (
      <div style={{ maxWidth: '800px' }}>
        <IntegrationsSelector
          {...args}
          selected={selected}
          onChange={setSelected}
          title="Select your data sources"
          titleAs="h3"
        />
      </div>
    )
  },
}

export const LimitedChips: Story = {
  render: function Render(args) {
    const [selected, setSelected] = useState<SelectedIntegration[]>([])
    return (
      <div style={{ maxWidth: '800px' }}>
        <IntegrationsSelector {...args} selected={selected} onChange={setSelected} chipsLimit={5} />
      </div>
    )
  },
}
