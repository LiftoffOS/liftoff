import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import Checkbox from './Checkbox'

const meta: Meta<typeof Checkbox> = {
  title: 'Components/Checkbox',
  component: Checkbox,
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof Checkbox>

function CheckboxDemo() {
  const [checked, setChecked] = useState(false)
  return <Checkbox checked={checked} onChange={setChecked} label="Send invite email now" />
}

export const Default: Story = {
  render: () => <CheckboxDemo />,
}

export const Checked: Story = {
  args: {
    checked: true,
    onChange: () => {},
    label: 'Include in regular pay calculations',
  },
}

export const Disabled: Story = {
  args: {
    checked: false,
    onChange: () => {},
    label: 'Disabled option',
    disabled: true,
  },
}
