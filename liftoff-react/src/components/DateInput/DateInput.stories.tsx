import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import DateInput from './DateInput'

const meta: Meta<typeof DateInput> = {
  title: 'Components/DateInput',
  component: DateInput,
  parameters: {
    layout: 'centered',
  },
  decorators: [(Story) => <div style={{ width: 300 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof DateInput>

function DateInputDemo() {
  const [value, setValue] = useState('')
  return <DateInput label="Effective Date" value={value} onChange={setValue} />
}

export const Default: Story = {
  render: () => <DateInputDemo />,
}

export const WithValue: Story = {
  args: {
    label: 'Start Date',
    value: '03/30/2026',
    onChange: () => {},
  },
}

export const NoLabel: Story = {
  args: {
    value: '',
    onChange: () => {},
  },
}

export const Disabled: Story = {
  args: {
    label: 'End Date',
    value: '12/31/2026',
    onChange: () => {},
    disabled: true,
  },
}
