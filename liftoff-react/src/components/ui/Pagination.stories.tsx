import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Pagination from './Pagination'

const meta: Meta<typeof Pagination> = {
  title: 'UI/Pagination',
  component: Pagination,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof Pagination>

export const Default: Story = {
  render: function Render() {
    const [current, setCurrent] = useState(1)
    return (
      <Pagination
        current={current}
        total={10}
        onPrevious={() => setCurrent(c => Math.max(1, c - 1))}
        onNext={() => setCurrent(c => Math.min(10, c + 1))}
      />
    )
  },
}

export const FirstPage: Story = {
  args: {
    current: 1,
    total: 10,
    onPrevious: () => {},
    onNext: () => {},
  },
}

export const LastPage: Story = {
  args: {
    current: 10,
    total: 10,
    onPrevious: () => {},
    onNext: () => {},
  },
}

export const MiddlePage: Story = {
  args: {
    current: 5,
    total: 10,
    onPrevious: () => {},
    onNext: () => {},
  },
}

export const SinglePage: Story = {
  args: {
    current: 1,
    total: 1,
    onPrevious: () => {},
    onNext: () => {},
  },
}
