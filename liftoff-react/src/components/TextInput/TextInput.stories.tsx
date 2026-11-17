import type { Meta, StoryObj } from '@storybook/react'
import TextInput from './TextInput'

const meta: Meta<typeof TextInput> = {
  title: 'Components/TextInput',
  component: TextInput,
  parameters: {
    layout: 'centered',
  },
  decorators: [(Story) => <div style={{ width: 400 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof TextInput>

export const Default: Story = {
  args: {
    label: 'Company Name',
    placeholder: 'e.g. Acme Corp',
  },
}

export const WithValue: Story = {
  args: {
    label: 'Company Name',
    value: 'Good Web Design, Inc.',
  },
}

export const WithHint: Story = {
  args: {
    label: 'Federal EIN',
    placeholder: '##-#######',
    hint: 'Format: ##-####### (9 digits)',
  },
}

export const WithError: Story = {
  args: {
    label: 'Email',
    value: 'invalid',
    error: 'Please enter a valid email address',
  },
}

export const Disabled: Story = {
  args: {
    label: 'Name',
    value: 'Jane Smith',
    disabled: true,
  },
}

export const NoLabel: Story = {
  args: {
    placeholder: 'Search...',
  },
}

export const Search: Story = {
  args: {
    variant: 'search',
    placeholder: 'Search agents...',
  },
}

export const SearchWithLabel: Story = {
  args: {
    variant: 'search',
    label: 'Find agents',
    placeholder: 'Type to search...',
  },
}
