import type { Meta, StoryObj } from '@storybook/react-vite'
import ActionMenu from './ActionMenu'

const meta: Meta<typeof ActionMenu> = {
  title: 'UI/ActionMenu',
  component: ActionMenu,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof ActionMenu>

export const Default: Story = {
  args: {
    items: [
      { label: 'Edit', onClick: () => {} },
      { label: 'Duplicate', onClick: () => {} },
      { label: 'Delete', onClick: () => {} },
    ],
  },
}

export const WithDangerItem: Story = {
  args: {
    items: [
      { label: 'Edit', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, variant: 'danger' },
    ],
  },
}

export const WithDisabledItem: Story = {
  args: {
    items: [
      { label: 'Edit', onClick: () => {} },
      { label: 'Disabled Action', onClick: () => {}, disabled: true },
      { label: 'Delete', onClick: () => {}, variant: 'danger' },
    ],
  },
}

export const Disabled: Story = {
  args: {
    disabled: true,
    items: [
      { label: 'Edit', onClick: () => {} },
      { label: 'Duplicate', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, variant: 'danger' },
    ],
  },
}
