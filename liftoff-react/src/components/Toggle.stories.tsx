import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Toggle from './Toggle'

const meta: Meta<typeof Toggle> = {
  title: 'Atomic/Toggle',
  component: Toggle,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
    disabled: { control: 'boolean' },
  },
}

export default meta
type Story = StoryObj<typeof Toggle>

export const Default: Story = {
  render: function Render(args) {
    const [checked, setChecked] = useState(false)
    return <Toggle {...args} checked={checked} onChange={() => setChecked(!checked)} />
  },
}

export const Checked: Story = {
  render: function Render(args) {
    const [checked, setChecked] = useState(true)
    return <Toggle {...args} checked={checked} onChange={() => setChecked(!checked)} />
  },
}

export const Disabled: Story = {
  args: {
    label: 'Example setting',
    checked: false,
    onChange: () => {},
    disabled: true,
  },
}

export const DisabledChecked: Story = {
  args: {
    label: 'Example setting',
    checked: true,
    onChange: () => {},
    disabled: true,
  },
}

export const SmallSize: Story = {
  render: function Render(args) {
    const [checked, setChecked] = useState(false)
    return <Toggle {...args} checked={checked} onChange={() => setChecked(!checked)} size="sm" />
  },
}
