import type { Meta, StoryObj } from '@storybook/react'
const fn = () => () => {}
import ExternalAgentSelector from './ExternalAgentSelector'
import type { ExternalAgent } from '../services/externalAgents'

const makeAgent = (overrides: Partial<ExternalAgent>): ExternalAgent => ({
  id: 'agent-1',
  tenantId: 'tenant-1',
  name: 'Data Analyst Agent',
  endpointUrl: 'https://agent.example.com/mcp',
  description: 'Analyzes data and produces reports.',
  connectionType: 'automatic',
  authType: 'api_key',
  collaborationMode: 'two_way',
  summary: 'Helps with data analysis tasks.',
  collaborationHints: null,
  detectedCapabilities: [],
  detectedResources: [],
  toolClassifications: {},
  allowedInternalAgentIds: [],
  requestRules: [],
  status: 'connected',
  capabilityChanges: null,
  costAmount: null,
  costType: null,
  monthlyCost: null,
  tasks30d: 0,
  currentVersion: 1,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  lastActivity: null,
  lastActivityAction: null,
  tunnelRouteId: null,
  ...overrides,
})

const connectedAgents: ExternalAgent[] = [
  makeAgent({ id: 'agent-1', name: 'Data Analyst', description: 'Runs data analysis and generates reports.' }),
  makeAgent({ id: 'agent-2', name: 'Content Writer', description: 'Drafts blog posts and marketing copy.' }),
  makeAgent({ id: 'agent-3', name: 'Support Bot', description: 'Handles customer support queries.' }),
]

const meta: Meta<typeof ExternalAgentSelector> = {
  title: 'Components/ExternalAgentSelector',
  component: ExternalAgentSelector,
  parameters: { layout: 'centered' },
  args: {
    onChange: fn(),
  },
}

export default meta
type Story = StoryObj<typeof ExternalAgentSelector>

export const Default: Story = {
  args: {
    available: connectedAgents,
    selected: [],
  },
}

export const WithSelections: Story = {
  args: {
    available: connectedAgents,
    selected: ['agent-1', 'agent-3'],
  },
}

export const AllSelected: Story = {
  args: {
    available: connectedAgents,
    selected: connectedAgents.map(a => a.id),
  },
}

export const Empty: Story = {
  name: 'Empty (no connected agents)',
  args: {
    available: [
      makeAgent({ id: 'agent-disconnected', name: 'Disconnected Agent', status: 'disconnected' }),
    ],
    selected: [],
  },
}
