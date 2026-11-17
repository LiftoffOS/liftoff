import type { Meta, StoryObj } from '@storybook/react'
import StreamingSparkline from './StreamingSparkline'

const meta: Meta<typeof StreamingSparkline> = {
  title: 'Components/Dashboard/StreamingSparkline',
  component: StreamingSparkline,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 400, height: 120 }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof StreamingSparkline>

export const Default: Story = {
  args: {},
}

export const TrendingUp: Story = {
  args: {
    color: '#22c55e',
    opacity: 0.2,
    speed: 30,
    trend: 'up',
    value: 50,
    seed: 42,
  },
}

export const TrendingDown: Story = {
  args: {
    color: '#ef4444',
    opacity: 0.2,
    speed: 30,
    trend: 'down',
    value: 60,
    seed: 99,
  },
}

export const Stable: Story = {
  args: {
    color: '#3b82f6',
    opacity: 0.15,
    speed: 20,
    trend: 'stable',
    value: 50,
    seed: 1234,
  },
}

export const FastSpeed: Story = {
  args: {
    color: '#f97316',
    opacity: 0.25,
    speed: 80,
    trend: 'up',
    value: 40,
    seed: 7,
  },
}

export const HighValue: Story = {
  args: {
    color: '#10b981',
    opacity: 0.2,
    speed: 30,
    trend: 'stable',
    value: 85,
    seed: 555,
  },
}

export const LowValue: Story = {
  args: {
    color: '#eab308',
    opacity: 0.2,
    speed: 30,
    trend: 'stable',
    value: 15,
    seed: 888,
  },
}
