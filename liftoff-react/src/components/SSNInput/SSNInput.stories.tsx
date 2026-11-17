import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { SSNInput } from './SSNInput'

const meta: Meta<typeof SSNInput> = {
  title: 'Components/SSNInput',
  component: SSNInput,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 300 }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof SSNInput>

const SSNInputWithState = (props: Partial<React.ComponentProps<typeof SSNInput>>) => {
  const [value, setValue] = useState(props.value ?? '')
  return (
    <SSNInput
      value={value}
      onChange={setValue}
      onSubmit={async (_ssn) => {}}
      {...props}
    />
  )
}

export const Default: Story = {
  render: () => <SSNInputWithState />,
}

export const WithValue: Story = {
  render: () => <SSNInputWithState value="123456789" />,
}

export const WithError: Story = {
  render: () => <SSNInputWithState error="Invalid SSN" />,
}

export const WithHint: Story = {
  render: () => <SSNInputWithState hint="We encrypt this immediately" />,
}
