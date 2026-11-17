import type { Meta, StoryObj } from '@storybook/react-vite'
import Tooltip from './Tooltip'
import Button from './Button'
import DotsGridIcon from '../assets/icons/dots-grid.svg?react'

const meta: Meta<typeof Tooltip> = {
  title: 'Atomic/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  argTypes: {
    position: {
      control: 'select',
      options: ['top', 'bottom'],
    },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: '60px', display: 'flex', justifyContent: 'center' }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Tooltip>

export const Bottom: Story = {
  args: {
    text: 'Tooltip text',
    position: 'bottom',
    children: <Button variant="primary">Hover me</Button>,
  },
}

export const Top: Story = {
  args: {
    text: 'Tooltip text',
    position: 'top',
    children: <Button variant="primary">Hover me</Button>,
  },
}

export const WithIconButton: Story = {
  render: () => (
    <Tooltip text="Explore Templates" position="bottom">
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          background: 'transparent',
          border: 'none',
          borderRadius: '50%',
          cursor: 'pointer',
          color: '#9ca3af',
        }}
      >
        <DotsGridIcon width={18} height={18} />
      </button>
    </Tooltip>
  ),
}
