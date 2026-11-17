import type { Meta, StoryObj } from '@storybook/react-vite'
import MetricCard from './MetricCard'

const meta: Meta<typeof MetricCard> = {
  title: 'Dashboard/MetricCard',
  component: MetricCard,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'large'],
    },
    trend: {
      control: 'select',
      options: ['up', 'down'],
    },
  },
}

export default meta
type Story = StoryObj<typeof MetricCard>

export const Default: Story = {
  args: {
    label: 'Total Tasks',
    value: '1,234',
  },
}

export const WithPositiveChange: Story = {
  args: {
    label: 'Revenue',
    value: '$45,231',
    change: 12.5,
    trend: 'up',
    period: 'vs last month',
  },
}

export const WithNegativeChange: Story = {
  args: {
    label: 'Churn Rate',
    value: '2.4%',
    change: -0.5,
    trend: 'down',
    period: 'vs last week',
  },
}

export const LargeSize: Story = {
  args: {
    label: 'Active Users',
    value: '12,847',
    change: 8.2,
    trend: 'up',
    period: 'this week',
    size: 'large',
  },
}

export const NumericValue: Story = {
  args: {
    label: 'Completed Tasks',
    value: 567,
  },
}
