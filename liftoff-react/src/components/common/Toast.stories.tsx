import type { Meta, StoryObj } from '@storybook/react-vite'
import Toast from './Toast'

const meta: Meta<typeof Toast> = {
  title: 'UI/Toast',
  component: Toast,
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'select',
      options: ['success', 'error'],
    },
    duration: { control: 'number' },
  },
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof Toast>

export const Success: Story = {
  args: {
    message: 'Changes saved successfully!',
    type: 'success',
    duration: 999999, // Long duration for demo
    onClose: () => {},
  },
}

export const Error: Story = {
  args: {
    message: 'Something went wrong. Please try again.',
    type: 'error',
    duration: 999999,
    onClose: () => {},
  },
}

export const LongMessage: Story = {
  args: {
    message: 'This is a much longer message that demonstrates how the toast handles extended content that might wrap to multiple lines.',
    type: 'success',
    duration: 999999,
    onClose: () => {},
  },
}
