import type { Meta, StoryObj } from '@storybook/react-vite'
import ActivityFeed from './ActivityFeed'

const meta: Meta<typeof ActivityFeed> = {
  title: 'Dashboard/ActivityFeed',
  component: ActivityFeed,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof ActivityFeed>

const sampleItems = [
  {
    id: '1',
    type: 'ai' as const,
    title: 'AI completed task',
    timestamp: new Date().toISOString(),
    details: 'Processed 150 records automatically',
  },
  {
    id: '2',
    type: 'human' as const,
    title: 'User approved workflow',
    timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
    details: 'Invoice processing workflow approved',
  },
  {
    id: '3',
    type: 'system' as const,
    title: 'System update',
    timestamp: new Date(Date.now() - 60 * 60000).toISOString(),
    details: 'New integration available: Slack',
  },
]

export const Default: Story = {
  args: {
    items: sampleItems,
  },
}

export const AIActivities: Story = {
  args: {
    items: [
      {
        id: '1',
        type: 'ai' as const,
        title: 'AI classified documents',
        timestamp: new Date().toISOString(),
        details: 'Sorted 45 invoices into categories',
      },
      {
        id: '2',
        type: 'ai' as const,
        title: 'AI extracted data',
        timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
        details: 'Extracted fields from 23 contracts',
      },
    ],
  },
}

export const HumanActivities: Story = {
  args: {
    items: [
      {
        id: '1',
        type: 'human' as const,
        title: 'Manager reviewed exceptions',
        timestamp: new Date().toISOString(),
        details: '5 items flagged for review',
      },
      {
        id: '2',
        type: 'human' as const,
        title: 'Team member updated workflow',
        timestamp: new Date(Date.now() - 45 * 60000).toISOString(),
        details: 'Modified approval rules',
      },
    ],
  },
}

export const Empty: Story = {
  args: {
    items: [],
  },
}
