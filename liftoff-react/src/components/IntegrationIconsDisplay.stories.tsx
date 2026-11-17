import type { Meta, StoryObj } from '@storybook/react'
import { AppProviders } from '../../.storybook/withAppProviders'
import IntegrationIconsDisplay from './IntegrationIconsDisplay'

const meta: Meta<typeof IntegrationIconsDisplay> = {
  title: 'Components/IntegrationIconsDisplay',
  component: IntegrationIconsDisplay,
  parameters: { layout: 'centered' },
  args: {
    appIntegrations: [],
    externalAgentCount: 0,
    classPrefix: 'agent-card',
  },
  decorators: [
    // useConnectorLookup reaches useAuth, so the icons need the app context.
    (Story) => (
      <AppProviders>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Story />
        </div>
      </AppProviders>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof IntegrationIconsDisplay>

// Note: stories render fallback icons since connector UUID resolution
// requires live backend data. Use Storybook with MSW mocks for full fidelity.

export const WithExternalAgents: Story = {
  args: {
    appIntegrations: [],
    externalAgentCount: 3,
  },
}

export const Empty: Story = {
  args: {
    appIntegrations: [],
    externalAgentCount: 0,
  },
}
