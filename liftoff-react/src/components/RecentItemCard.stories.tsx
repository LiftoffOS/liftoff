import type { Meta, StoryObj } from '@storybook/react'
import { RecentItemCard } from './RecentItemCard'

const meta: Meta<typeof RecentItemCard> = {
  title: 'Components/RecentItemCard',
  component: RecentItemCard,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 300 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    id: 'item-1',
    name: 'Marketing Assistant',
    timeLabel: 'Updated 2 hours ago',
    onUpdate: () => console.log('update'),
    onToggleStatus: () => console.log('toggle status'),
    onArchive: () => console.log('archive'),
    onMessage: () => console.log('message'),
    toggleStatusLabel: 'Pause Team',
  },
}

export default meta
type Story = StoryObj<typeof RecentItemCard>

export const Active: Story = {
  args: {
    status: 'active',
    toggleStatusLabel: 'Pause Team',
  },
}

export const Paused: Story = {
  args: {
    status: 'paused',
    toggleStatusLabel: 'Activate Team',
  },
}

export const Draft: Story = {
  args: {
    status: 'draft',
    toggleStatusLabel: 'Activate Team',
  },
}

export const External: Story = {
  args: {
    status: 'active',
    name: 'External Agent',
    isExternal: true,
    toggleStatusLabel: 'Pause Team',
  },
}
