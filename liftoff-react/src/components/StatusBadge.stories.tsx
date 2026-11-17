import type { Meta, StoryObj } from '@storybook/react-vite'
import StatusBadge from './StatusBadge'

const meta: Meta<typeof StatusBadge> = {
  title: 'Atomic/StatusBadge',
  component: StatusBadge,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['active', 'success', 'paused', 'neutral', 'warning', 'draft', 'error'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
}

export default meta
type Story = StoryObj<typeof StatusBadge>

export const Active: Story = {
  args: {
    variant: 'active',
    children: 'Active',
  },
}

export const Success: Story = {
  args: {
    variant: 'success',
    children: 'Success',
  },
}

export const Paused: Story = {
  args: {
    variant: 'paused',
    children: 'Paused',
  },
}

export const Neutral: Story = {
  args: {
    variant: 'neutral',
    children: 'Neutral',
  },
}

export const Warning: Story = {
  args: {
    variant: 'warning',
    children: 'Warning',
  },
}

export const Draft: Story = {
  args: {
    variant: 'draft',
    children: 'Draft',
  },
}

export const Error: Story = {
  args: {
    variant: 'error',
    children: 'Error',
  },
}

export const MediumSize: Story = {
  args: {
    variant: 'success',
    children: 'Medium Badge',
    size: 'md',
  },
}
