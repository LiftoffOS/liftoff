import type { Meta, StoryObj } from '@storybook/react-vite'
import StatusDot from './StatusDot'

const meta: Meta<typeof StatusDot> = {
  title: 'Atomic/StatusDot',
  component: StatusDot,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['connected', 'success', 'warning', 'error', 'neutral', 'info'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    pulse: { control: 'boolean' },
  },
}

export default meta
type Story = StoryObj<typeof StatusDot>

export const Connected: Story = {
  args: {
    variant: 'connected',
  },
}

export const Success: Story = {
  args: {
    variant: 'success',
  },
}

export const Warning: Story = {
  args: {
    variant: 'warning',
  },
}

export const Error: Story = {
  args: {
    variant: 'error',
  },
}

export const Neutral: Story = {
  args: {
    variant: 'neutral',
  },
}

export const Info: Story = {
  args: {
    variant: 'info',
  },
}

export const Pulsing: Story = {
  args: {
    variant: 'connected',
    pulse: true,
  },
}

export const LargeSize: Story = {
  args: {
    variant: 'success',
    size: 'lg',
  },
}

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
      <StatusDot variant="success" size="sm" />
      <StatusDot variant="success" size="md" />
      <StatusDot variant="success" size="lg" />
    </div>
  ),
}
