import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import NeedsAttentionPanel from './NeedsAttentionPanel'

const meta: Meta<typeof NeedsAttentionPanel> = {
  title: 'Components/Dashboard/NeedsAttentionPanel',
  component: NeedsAttentionPanel,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
}

export default meta
type Story = StoryObj<typeof NeedsAttentionPanel>

export const Empty: Story = {
  args: {
    items: [],
  },
}

export const SingleCritical: Story = {
  args: {
    items: [
      {
        id: '1',
        type: 'approval',
        severity: 'critical',
        title: 'Approval waiting',
        description: 'An agent is waiting for approval before it sends a customer email.',
        action: 'Review now',
        link: '/dashboard/review',
      },
    ],
  },
}

export const MixedSeverities: Story = {
  args: {
    items: [
      {
        id: '1',
        type: 'connection',
        severity: 'critical',
        title: 'Connection expired',
        description: 'The Slack connection needs to be re-authorised.',
        action: 'Reconnect',
        link: '/dashboard/connections',
      },
      {
        id: '2',
        type: 'agent',
        severity: 'high',
        title: 'Agent paused',
        description: 'Support Triage paused after three failed runs.',
        action: 'Review',
        link: '/dashboard/agents',
      },
      {
        id: '3',
        type: 'billing',
        severity: 'medium',
        title: 'Operating units running low',
        description: 'This workspace has used 90% of its operating units.',
        action: 'View',
        link: '/dashboard/settings/billing',
      },
      {
        id: '4',
        type: 'onboarding',
        severity: 'low',
        title: 'Onboarding incomplete',
        description: '1 new hire has not completed onboarding steps.',
        action: 'Follow up',
        link: '/dashboard/onboarding',
      },
      {
        id: '5',
        type: 'system',
        severity: 'info',
        title: 'System maintenance scheduled',
        description: 'Planned maintenance window on Saturday 2am–4am PST.',
        action: 'Dismiss',
        link: '/dashboard',
      },
    ],
  },
}

export const AllCritical: Story = {
  args: {
    items: [
      {
        id: '1',
        type: 'approval',
        severity: 'critical',
        title: 'Approval waiting',
        description: 'An agent is waiting for approval before it sends a customer email.',
        action: 'Review now',
        link: '/dashboard/review',
      },
      {
        id: '2',
        type: 'connection',
        severity: 'critical',
        title: 'Connection expired',
        description: 'The Slack connection needs to be re-authorised.',
        action: 'Reconnect',
        link: '/dashboard/connections',
      },
    ],
  },
}
