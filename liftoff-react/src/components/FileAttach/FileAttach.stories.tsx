// The whole attachment flow: the composer's "+" button, the popover it opens,
// and the connector list inside it.
//
// The popover reads live connector state (useIntegrations -> useConnectors /
// useConnectorCatalog -> useAuth), so stories need both a QueryClientProvider
// and a stand-in auth context or the component throws on render. Same decorator
// pattern as Dashboard/Sidebar.stories.tsx.
//
// The stand-in session is deliberately empty: both connector queries are
// guarded by `enabled` on user / tenant, so with neither set nothing is
// fetched and the story stays offline. The provider list is hardcoded in the
// component, so it renders in full either way, with every provider in its
// unconnected state.

import { useState } from 'react'
import type { ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthContext } from '../../contexts/AuthContext'
import { FileUploadButton, FileUploadPopover, type PendingAttachment } from '.'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const mockAuthValue = {
  user: null,
  currentTenant: null,
  tenantLoading: false,
  loading: false,
  backendConnected: true,
  getIdToken: async () => null,
} as unknown as ComponentProps<typeof AuthContext.Provider>['value']

const meta: Meta<typeof FileUploadButton> = {
  title: 'Forms/FileAttach',
  component: FileUploadButton,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <AuthContext.Provider value={mockAuthValue}>
        <QueryClientProvider client={queryClient}>
          <Story />
        </QueryClientProvider>
      </AuthContext.Provider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FileUploadButton>

// The flow as a composer actually uses it: click the button, the popover opens
// in a portal positioned against it.
export const Default: Story = {
  render: function Render() {
    const [attached, setAttached] = useState<PendingAttachment[]>([])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
        <FileUploadButton onAttach={(attachments) => setAttached(attachments)} />
        {attached.length > 0 && <p>Last attached: {attached.map((a) => a.name).join(', ')}</p>}
      </div>
    )
  },
}

// The popover on its own, held open so the connector list stays inspectable in
// autodocs (the portal version above closes on any outside click).
export const PopoverOpen: Story = {
  render: function Render() {
    const [isOpen, setIsOpen] = useState(true)
    return (
      <div style={{ position: 'relative' }}>
        <button type="button" onClick={() => setIsOpen(true)}>Open popover</button>
        <FileUploadPopover
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          onAttach={(attachments) => console.log('Attached:', attachments)}
        />
      </div>
    )
  },
}

export const PopoverClosed: Story = {
  render: () => (
    <FileUploadPopover isOpen={false} onClose={() => {}} onAttach={() => {}} />
  ),
}
