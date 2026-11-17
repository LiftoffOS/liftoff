import type { Meta, StoryObj } from '@storybook/react'
import Collapsible from './Collapsible'

const SampleContent = () => (
  <ul style={{ margin: 0, padding: '0 0 0 1rem', listStyle: 'disc' }}>
    <li>Item one</li>
    <li>Item two</li>
    <li>Item three</li>
  </ul>
)

const meta: Meta<typeof Collapsible> = {
  title: 'Components/UI/Collapsible',
  component: Collapsible,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    defaultOpen: { control: 'boolean' },
    count: { control: { type: 'number', min: 0 } },
    title: { control: 'text' },
  },
}

export default meta
type Story = StoryObj<typeof Collapsible>

export const Default: Story = {
  args: {
    title: 'Section Title',
    defaultOpen: false,
    children: <SampleContent />,
  },
}

export const Expanded: Story = {
  args: {
    title: 'Section Title',
    defaultOpen: true,
    children: <SampleContent />,
  },
}

export const WithCount: Story = {
  args: {
    title: 'Team Members',
    defaultOpen: true,
    count: 5,
    children: <SampleContent />,
  },
}

export const WithCountCollapsed: Story = {
  args: {
    title: 'Pending Reviews',
    defaultOpen: false,
    count: 12,
    children: <SampleContent />,
  },
}

export const ZeroCount: Story = {
  args: {
    title: 'Notifications',
    defaultOpen: false,
    count: 0,
    children: <p style={{ margin: 0 }}>No notifications.</p>,
  },
}
