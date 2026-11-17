import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { AppProviders } from '../../.storybook/withAppProviders'
import ResponsibilitiesInput from './ResponsibilitiesInput'
import { RESPONSIBILITIES_TEMPLATE } from './guidanceTemplates'

const meta: Meta<typeof ResponsibilitiesInput> = {
  title: 'Components/ResponsibilitiesInput',
  component: ResponsibilitiesInput,
  parameters: { layout: 'centered' },
  decorators: [
    // Renders the attachment picker, which reaches useAuth and useToast.
    (Story) => (
      <AppProviders>
        <div style={{ width: 640 }}>
          <Story />
        </div>
      </AppProviders>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ResponsibilitiesInput>

function Controlled(props: Partial<React.ComponentProps<typeof ResponsibilitiesInput>>) {
  const [value, setValue] = useState(props.value ?? '')
  return <ResponsibilitiesInput {...props} value={value} onChange={setValue} />
}

export const Default: Story = {
  render: () => <Controlled />,
}

export const WithValue: Story = {
  render: () => (
    <Controlled
      value={`## Responsibilities\nHandle all inbound customer support tickets.\n## Goals\nResolve 90% of tickets without escalation.\n## Workflows\n1. Triage ticket\n2. Look up customer account\n3. Respond with solution\n## Instructions\nAlways escalate billing disputes to the finance team.\n## Outcomes\nCustomer receives a resolution within 24 hours.`}
    />
  ),
}

export const WithTemplate: Story = {
  render: () => <Controlled value={RESPONSIBILITIES_TEMPLATE} />,
}

export const CustomTitle: Story = {
  render: () => (
    <Controlled
      title="What should this agent be responsible for?"
      titleAs="h3"
    />
  ),
}

export const CustomPlaceholder: Story = {
  render: () => (
    <Controlled
      placeholder="Describe the core duties and expected outcomes for this agent..."
    />
  ),
}

export const NoTitle: Story = {
  render: () => <Controlled title="" />,
}

export const WithAttachments: Story = {
  render: function Render() {
    const [value, setValue] = useState('')
    const [attachments, setAttachments] = useState<
      React.ComponentProps<typeof ResponsibilitiesInput>['attachments']
    >([
      {
        kind: 'upload',
        name: 'skills.md',
        content: '# Skills\nTriage tickets and escalate billing disputes.',
        addedAt: new Date().toISOString(),
        source: 'responsibilities',
      },
    ])
    return (
      <ResponsibilitiesInput
        value={value}
        onChange={setValue}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
    )
  },
}
