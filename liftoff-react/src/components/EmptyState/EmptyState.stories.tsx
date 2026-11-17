import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import EmptyState from './EmptyState'
import SearchIcon from '../../assets/icons/search.svg?react'
import PersonSingleIcon from '../../assets/icons/person-single.svg?react'

const meta: Meta<typeof EmptyState> = {
  title: 'Components/EmptyState',
  component: EmptyState,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <div style={{ width: 400 }}><MemoryRouter><Story /></MemoryRouter></div>],
}

export default meta
type Story = StoryObj<typeof EmptyState>

export const Default: Story = {
  args: {
    title: 'No items found',
    description: 'Try adjusting your search or filters.',
  },
}

export const WithIcon: Story = {
  args: {
    icon: <SearchIcon />,
    title: 'No results',
    description: 'Try a different search term.',
  },
}

export const WithAction: Story = {
  args: {
    icon: <PersonSingleIcon />,
    title: 'No people added yet',
    description: 'Invite people to your workspace to get started.',
    action: <button style={{ padding: '6px 16px', borderRadius: '8px', border: 'none', background: '#FB411F', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Add Person</button>,
  },
}

export const TitleOnly: Story = {
  args: {
    title: 'No data available',
  },
}
