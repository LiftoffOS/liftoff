import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import ErrorState from './ErrorState'

const meta: Meta<typeof ErrorState> = {
  title: 'UI/ErrorState',
  component: ErrorState,
  tags: ['autodocs'],
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
}

export default meta
type Story = StoryObj<typeof ErrorState>

export const Error: Story = {
  args: {
    variant: 'error',
    onRetry: () => {},
  },
}

export const NotFound: Story = {
  args: {
    variant: 'notFound',
  },
}

export const CustomContent: Story = {
  args: {
    variant: 'error',
    title: 'Unable to load data',
    subtitle: 'There was a problem fetching your information. Please check your connection and try again.',
    buttonLabel: 'Retry',
    onRetry: () => {},
  },
}
