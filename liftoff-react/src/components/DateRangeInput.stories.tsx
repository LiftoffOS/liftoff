import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { DateRangeInput } from './DateRangeInput'

const meta: Meta<typeof DateRangeInput> = {
  title: 'Components/DateRangeInput',
  component: DateRangeInput,
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof DateRangeInput>

function DateRangeDemo() {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  return (
    <DateRangeInput
      startDate={start}
      endDate={end}
      onStartDateChange={setStart}
      onEndDateChange={setEnd}
    />
  )
}

export const Default: Story = {
  render: () => <DateRangeDemo />,
}

export const WithValues: Story = {
  args: {
    startDate: '03/01/2026',
    endDate: '03/30/2026',
    onStartDateChange: () => {},
    onEndDateChange: () => {},
  },
}

export const CustomLabels: Story = {
  args: {
    startDate: '',
    endDate: '',
    startLabel: 'Start',
    endLabel: 'End',
    onStartDateChange: () => {},
    onEndDateChange: () => {},
  },
}

export const Disabled: Story = {
  args: {
    startDate: '03/01/2026',
    endDate: '03/30/2026',
    disabled: true,
    onStartDateChange: () => {},
    onEndDateChange: () => {},
  },
}
