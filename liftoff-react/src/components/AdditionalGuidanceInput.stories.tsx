import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { AppProviders } from '../../.storybook/withAppProviders'
import AdditionalGuidanceInput from './AdditionalGuidanceInput'
import { GUIDANCE_TEMPLATE } from './guidanceTemplates'

const meta: Meta<typeof AdditionalGuidanceInput> = {
  title: 'Components/AdditionalGuidanceInput',
  component: AdditionalGuidanceInput,
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
type Story = StoryObj<typeof AdditionalGuidanceInput>

function Controlled(props: Partial<React.ComponentProps<typeof AdditionalGuidanceInput>>) {
  const [value, setValue] = useState(props.value ?? '')
  return <AdditionalGuidanceInput {...props} value={value} onChange={setValue} />
}

export const Default: Story = {
  render: () => <Controlled />,
}

export const WithValue: Story = {
  render: () => (
    <Controlled
      value={`## Specific instructions\nAlways greet the customer by name.\n## Rules\nNever promise a refund without manager approval.\n## Constraints\nRespond within 2 business days.`}
    />
  ),
}

export const WithPlaceholder: Story = {
  render: () => (
    <Controlled
      placeholder="Enter any additional guidance for this agent..."
    />
  ),
}

export const WithTemplate: Story = {
  render: () => <Controlled value={GUIDANCE_TEMPLATE} />,
}

export const CustomTitle: Story = {
  render: () => (
    <Controlled
      title="Any special instructions for this workflow?"
      titleAs="h3"
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
      React.ComponentProps<typeof AdditionalGuidanceInput>['attachments']
    >([
      {
        kind: 'upload',
        name: 'edge-cases.md',
        content: '# Edge cases\nNever promise a refund without manager approval.',
        addedAt: new Date().toISOString(),
        source: 'guidance',
      },
    ])
    return (
      <AdditionalGuidanceInput
        value={value}
        onChange={setValue}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
    )
  },
}
