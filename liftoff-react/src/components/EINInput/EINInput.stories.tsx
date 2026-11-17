import type { Meta, StoryObj } from '@storybook/react'
import { EINInput } from './EINInput'

const meta: Meta<typeof EINInput> = {
  title: 'Components/EINInput',
  component: EINInput,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <div style={{ width: 300 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof EINInput>

export const Default: Story = {
  args: {
    value: '',
    onChange: () => {},
  },
}

export const WithValue: Story = {
  args: {
    value: '12-3456789',
    onChange: () => {},
  },
}

export const WithError: Story = {
  args: {
    value: '12',
    onChange: () => {},
    error: 'Invalid EIN',
  },
}

export const CustomLabel: Story = {
  args: {
    value: '',
    onChange: () => {},
    label: 'Company EIN',
  },
}
