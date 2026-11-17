import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import CollapsibleSection from './CollapsibleSection'

const meta: Meta<typeof CollapsibleSection> = {
  title: 'Components/CollapsibleSection',
  component: CollapsibleSection,
  parameters: {
    layout: 'centered',
  },
  decorators: [(Story) => <div style={{ width: 500 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof CollapsibleSection>

function BasicDemo() {
  const [open, setOpen] = useState(false)
  return (
    <CollapsibleSection title="Advanced Settings" isOpen={open} onToggle={() => setOpen(!open)}>
      <p style={{ fontSize: 14, color: '#666' }}>Content inside the collapsible section.</p>
    </CollapsibleSection>
  )
}

export const Default: Story = {
  render: () => <BasicDemo />,
}

function WithCheckDemo() {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <CollapsibleSection title="Company Details" isOpen={false} onToggle={() => {}} showCheck isComplete summary="Acme Corp • San Francisco, CA">
        <p>Form content here</p>
      </CollapsibleSection>
      <CollapsibleSection title="Tax Information" isOpen={open} onToggle={() => setOpen(!open)} showCheck>
        <p style={{ fontSize: 14 }}>Enter your EIN and tax details.</p>
      </CollapsibleSection>
      <CollapsibleSection title="Bank Account" isOpen={false} onToggle={() => {}} showCheck disabled>
        <p>Locked until previous sections complete.</p>
      </CollapsibleSection>
    </div>
  )
}

export const WithCheckboxes: Story = {
  render: () => <WithCheckDemo />,
}

export const Disabled: Story = {
  args: {
    title: 'Authorization Forms',
    isOpen: false,
    onToggle: () => {},
    disabled: true,
    children: <p>This section is locked.</p>,
  },
}

export const WithSummary: Story = {
  args: {
    title: 'Pay Period',
    isOpen: false,
    onToggle: () => {},
    showCheck: true,
    isComplete: true,
    summary: '03/01/2026 - 03/15/2026',
    children: <p>Pay period details.</p>,
  },
}
