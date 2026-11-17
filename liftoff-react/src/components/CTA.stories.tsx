import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import CTA from './CTA'

const meta: Meta<typeof CTA> = {
  title: 'Marketing/CTA',
  component: CTA,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
}

export default meta
type Story = StoryObj<typeof CTA>

export const Default: Story = {}
