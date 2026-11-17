import type { Meta, StoryObj } from '@storybook/react'
import { AppProviders } from '../../.storybook/withAppProviders'
import { SelectableAgentCard } from './SelectableAgentCard'
import type { InternalAgent } from '../services/internalAgents'

const mockTeam: InternalAgent = {
  id: 'team-1',
  role: 'Content Writer',
  responsibilities: 'Drafts blog posts, newsletters, and marketing copy based on briefs.',
  integrations: [
    { id: 'google_mail', selectedObjects: [] },
    { id: 'slack', selectedObjects: [] },
    { id: 'google_drive', selectedObjects: [] },
  ],
  summary: 'Handles all written content creation for marketing campaigns.',
  temperature: 0.7,
  status: 'active',
  currentVersion: 3,
  tasksCompleted: 42,
  tasks30d: 14,
  monthlyCost: 120,
  createdAt: '2024-01-15T10:00:00Z',
  updatedAt: '2024-03-01T14:30:00Z',
  lastActive: '2024-03-20T09:15:00Z',
  messagingNickname: null,
  lastActivity: null,
  lastActivityAction: null,
  workflowVisualizationSteps: null,
  autonomyOverride: null,
  aiVendorOverride: null,
}

const meta: Meta<typeof SelectableAgentCard> = {
  title: 'Components/SelectableAgentCard',
  component: SelectableAgentCard,
  parameters: { layout: 'centered' },
  decorators: [
    // Resolves each integration id through useConnectorLookup, which reaches useAuth.
    (Story) => (
      <AppProviders>
        <Story />
      </AppProviders>
    ),
  ],
  args: {
    team: mockTeam,
    selected: false,
    onToggle: (id) => console.log('toggled', id),
  },
}

export default meta
type Story = StoryObj<typeof SelectableAgentCard>

export const Default: Story = {}

export const Selected: Story = {
  args: {
    selected: true,
  },
}

export const Disabled: Story = {
  args: {
    disabled: true,
  },
}

export const WithCost: Story = {
  args: {
    showCost: true,
  },
}
