import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import RoleInput from './RoleInput'

const meta: Meta<typeof RoleInput> = {
  title: 'Forms/RoleInput',
  component: RoleInput,
  tags: ['autodocs'],
  argTypes: {
    titleAs: {
      control: 'select',
      options: ['h1', 'h2', 'h3'],
    },
    animated: { control: 'boolean' },
  },
}

export default meta
type Story = StoryObj<typeof RoleInput>

export const Default: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return <RoleInput {...args} value={value} onChange={setValue} />
  },
}

export const WithValue: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('Sales Engineer')
    return <RoleInput {...args} value={value} onChange={setValue} />
  },
}

export const NoAnimation: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return <RoleInput {...args} value={value} onChange={setValue} animated={false} />
  },
}

export const CustomTitle: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return (
      <RoleInput
        {...args}
        value={value}
        onChange={setValue}
        title="What role are you hiring for?"
        titleAs="h3"
      />
    )
  },
}

export const NoTitle: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return <RoleInput {...args} value={value} onChange={setValue} title="" />
  },
}
