import type { Meta, StoryObj } from '@storybook/react'
import OperatingHealth from './OperatingHealth'

const meta: Meta<typeof OperatingHealth> = {
  title: 'Components/Dashboard/OperatingHealth',
  component: OperatingHealth,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof OperatingHealth>

export const Default: Story = {
  args: {
    entering: 12,
    autonomous: 45,
    awaitingReview: 8,
    exceptions: 3,
    completed: 120,
    stuck: 2,
  },
}

export const MostlyAutonomous: Story = {
  args: {
    entering: 5,
    autonomous: 200,
    awaitingReview: 10,
    exceptions: 1,
    completed: 350,
    stuck: 0,
  },
}

export const HighExceptions: Story = {
  args: {
    entering: 20,
    autonomous: 30,
    awaitingReview: 40,
    exceptions: 35,
    completed: 60,
    stuck: 15,
  },
}

export const AllZeroExceptOne: Story = {
  args: {
    entering: 0,
    autonomous: 1,
    awaitingReview: 0,
    exceptions: 0,
    completed: 0,
    stuck: 0,
  },
}

export const EvenDistribution: Story = {
  args: {
    entering: 10,
    autonomous: 10,
    awaitingReview: 10,
    exceptions: 10,
    completed: 10,
    stuck: 10,
  },
}
