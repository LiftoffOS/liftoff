import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import SegmentedControl from './SegmentedControl'
import Grid2x2Icon from '../../assets/icons/grid-2x2.svg?react'
import LinesIcon from '../../assets/icons/lines.svg?react'

const meta: Meta<typeof SegmentedControl> = {
  title: 'UI/SegmentedControl',
  component: SegmentedControl,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof SegmentedControl>

export const Default: Story = {
  render: function Render() {
    const [value, setValue] = useState('option1')
    return (
      <SegmentedControl
        options={[
          { value: 'option1', label: 'Option 1' },
          { value: 'option2', label: 'Option 2' },
          { value: 'option3', label: 'Option 3' },
        ]}
        value={value}
        onChange={setValue}
      />
    )
  },
}

export const TwoOptions: Story = {
  render: function Render() {
    const [value, setValue] = useState('daily')
    return (
      <SegmentedControl
        options={[
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ]}
        value={value}
        onChange={setValue}
      />
    )
  },
}

export const WithIcons: Story = {
  render: function Render() {
    const [value, setValue] = useState('grid')
    return (
      <SegmentedControl
        options={[
          {
            value: 'grid',
            label: 'Grid',
            icon: <Grid2x2Icon width={16} height={16} />,
          },
          {
            value: 'list',
            label: 'List',
            icon: <LinesIcon width={16} height={16} />,
          },
        ]}
        value={value}
        onChange={setValue}
      />
    )
  },
}
