import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Dropdown } from './Dropdown'

const meta: Meta<typeof Dropdown> = {
  title: 'UI/Dropdown',
  component: Dropdown,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof Dropdown>

export const Default: Story = {
  render: function Render() {
    const [value, setValue] = useState('option1')
    return (
      <Dropdown
        options={[
          { value: 'option1', label: 'Option One' },
          { value: 'option2', label: 'Option Two' },
          { value: 'option3', label: 'Option Three' },
        ]}
        value={value}
        onChange={setValue}
      />
    )
  },
}

export const WithPlaceholder: Story = {
  render: function Render() {
    const [value, setValue] = useState('')
    return (
      <Dropdown
        options={[
          { value: 'option1', label: 'Option One' },
          { value: 'option2', label: 'Option Two' },
          { value: 'option3', label: 'Option Three' },
        ]}
        value={value}
        onChange={setValue}
        placeholder="Select an option..."
      />
    )
  },
}

export const Searchable: Story = {
  render: function Render() {
    const [value, setValue] = useState('us')
    return (
      <Dropdown
        options={[
          { value: 'us', label: 'United States' },
          { value: 'ca', label: 'Canada' },
          { value: 'gb', label: 'United Kingdom' },
          { value: 'au', label: 'Australia' },
          { value: 'de', label: 'Germany' },
          { value: 'fr', label: 'France' },
          { value: 'jp', label: 'Japan' },
        ]}
        value={value}
        onChange={setValue}
        searchable
        searchPlaceholder="Search countries..."
      />
    )
  },
}

export const Disabled: Story = {
  render: function Render() {
    const [value, setValue] = useState('option1')
    return (
      <Dropdown
        options={[
          { value: 'option1', label: 'Option One' },
          { value: 'option2', label: 'Option Two' },
          { value: 'option3', label: 'Option Three' },
        ]}
        value={value}
        onChange={setValue}
        disabled
      />
    )
  },
}
