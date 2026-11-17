import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import MarkdownTextarea from './MarkdownTextarea'

const meta: Meta<typeof MarkdownTextarea> = {
  title: 'Forms/MarkdownTextarea',
  component: MarkdownTextarea,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof MarkdownTextarea>

export const Default: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return (
      <div style={{ maxWidth: '600px' }}>
        <MarkdownTextarea {...args} value={value} onChange={setValue} />
      </div>
    )
  },
}

export const WithPlaceholder: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('')
    return (
      <div style={{ maxWidth: '600px' }}>
        <MarkdownTextarea
          {...args}
          value={value}
          onChange={setValue}
          placeholder="Start typing your content..."
        />
      </div>
    )
  },
}

export const WithContent: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('## Welcome\n\nThis is some example content with a heading.')
    return (
      <div style={{ maxWidth: '600px' }}>
        <MarkdownTextarea {...args} value={value} onChange={setValue} />
      </div>
    )
  },
}

export const LongContent: Story = {
  render: function Render(args) {
    const [value, setValue] = useState(`## Project Overview

This section contains the main project description and goals.

## Key Features

The system includes several important features that enable users to accomplish their tasks efficiently.

## Technical Requirements

Various technical specifications and requirements are outlined in this section.`)
    return (
      <div style={{ maxWidth: '600px' }}>
        <MarkdownTextarea {...args} value={value} onChange={setValue} />
      </div>
    )
  },
}
