import type { Meta, StoryObj } from '@storybook/react'
import ExternalAgentChip from './ExternalAgentChip'
import type { ExternalAgent } from '../services/externalAgents'

const mockAgent: ExternalAgent = {
  id: 'ext-agent-1',
  tenantId: 'tenant-1',
  name: 'Salesforce CRM',
  endpointUrl: 'https://api.salesforce.example.com',
  description: 'Manages customer relationships and sales pipeline data.',
  connectionType: 'custom',
  authType: 'api_key',
  collaborationMode: 'two_way',
  summary: 'CRM integration for sales data access.',
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
  createdAt: '2024-01-10T08:00:00Z',
  updatedAt: '2024-03-15T12:00:00Z',
  lastActivity: null,
  lastActivityAction: null,
  tunnelRouteId: null,
}

const meta: Meta<typeof ExternalAgentChip> = {
  title: 'Components/ExternalAgentChip',
  component: ExternalAgentChip,
  parameters: { layout: 'centered' },
  args: {
    agent: mockAgent,
    selected: false,
    onToggle: () => console.log('toggled'),
  },
}

export default meta
type Story = StoryObj<typeof ExternalAgentChip>

export const Default: Story = {}

export const Selected: Story = {
  args: {
    selected: true,
  },
}
