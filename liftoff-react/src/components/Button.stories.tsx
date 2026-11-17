import type { Meta, StoryObj } from '@storybook/react-vite'
import { AppProviders } from '../../.storybook/withAppProviders'
import Button from './Button'

const meta: Meta<typeof Button> = {
  title: 'Atomic/Button',
  component: Button,
  tags: ['autodocs'],
  decorators: [
    // Given `href`, Button renders a react-router Link, which throws without a
    // router above it. Only the AsLink story needs this, but a decorator on the
    // meta means the next story to take an href does not rediscover that.
    (Story) => (
      <AppProviders>
        <Story />
      </AppProviders>
    ),
  ],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'outline'],
    },
    size: {
      control: 'select',
      options: ['default', 'sm'],
    },
    disabled: { control: 'boolean' },
    loading: { control: 'boolean' },
  },
}

export default meta
type Story = StoryObj<typeof Button>

export const Primary: Story = {
  args: {
    children: 'Primary Button',
    variant: 'primary',
  },
}

export const Secondary: Story = {
  args: {
    children: 'Secondary Button',
    variant: 'secondary',
  },
}

export const Outline: Story = {
  args: {
    children: 'Outline Button',
    variant: 'outline',
  },
}

export const Small: Story = {
  args: {
    children: 'Small Button',
    size: 'sm',
  },
}

export const Loading: Story = {
  args: {
    children: 'Loading Button',
    loading: true,
  },
}

export const Disabled: Story = {
  args: {
    children: 'Disabled Button',
    disabled: true,
  },
}

export const AsLink: Story = {
  args: {
    children: 'Link Button',
    href: '/dashboard',
  },
}
