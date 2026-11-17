import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import PhoneInput from './PhoneInput'

const meta: Meta<typeof PhoneInput> = {
  title: 'Components/PhoneInput',
  component: PhoneInput,
  parameters: {
    layout: 'centered',
  },
  decorators: [(Story) => <div style={{ width: 400 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof PhoneInput>

function PhoneInputDemo() {
  const [value, setValue] = useState('')
  const [countryCode, setCountryCode] = useState('US')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ fontSize: 14, fontWeight: 600 }} htmlFor="phoneinput-stories-phone">Phone</label>
      <PhoneInput id="phoneinput-stories-phone"
        value={value}
        countryCode={countryCode}
        onChange={setValue}
        onCountryCodeChange={setCountryCode}
      />
      <span style={{ fontSize: 12, color: '#888' }}>
        Raw digits: {value || '(empty)'}
      </span>
    </div>
  )
}

export const Default: Story = {
  render: () => <PhoneInputDemo />,
}

export const Required: Story = {
  args: {
    value: '',
    countryCode: 'US',
    onChange: () => {},
    onCountryCodeChange: () => {},
    required: true,
  },
}

export const WithValue: Story = {
  args: {
    value: '5551234567',
    countryCode: 'US',
    onChange: () => {},
    onCountryCodeChange: () => {},
  },
}
