import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import Footer from './Footer'

const meta: Meta<typeof Footer> = {
  title: 'Marketing/Footer',
  component: Footer,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
}

export default meta
type Story = StoryObj<typeof Footer>

export const Default: Story = {}
