import type { Meta, StoryObj } from '@storybook/react-vite'
import BackButton from './BackButton'

const meta: Meta<typeof BackButton> = {
  title: 'UI/BackButton',
  component: BackButton,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof BackButton>

export const Default: Story = {
  args: {
    onClick: () => {},
  },
}

export const WithCustomClass: Story = {
  args: {
    onClick: () => {},
    className: 'custom-back-button',
  },
}
