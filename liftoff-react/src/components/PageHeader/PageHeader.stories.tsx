import type { Meta, StoryObj } from '@storybook/react'
import PageHeader from './PageHeader'

const meta: Meta<typeof PageHeader> = {
  title: 'Components/PageHeader',
  component: PageHeader,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ width: 800 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof PageHeader>

export const TitleOnly: Story = {
  args: { title: 'Teams' },
}

export const WithSubtitle: Story = {
  args: {
    title: 'Connections',
    subtitle: 'Connect your tools and services to power your AI workforce.',
  },
}

export const WithActions: Story = {
  render: () => (
    <PageHeader title="Teams">
      <button style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #ddd', background: 'white', cursor: 'pointer' }}>
        Add Function
      </button>
    </PageHeader>
  ),
}

export const WithSubtitleAndActions: Story = {
  render: () => (
    <PageHeader title="Activity" subtitle="View agent audit logs and actions.">
      <button style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #ddd', background: 'white', cursor: 'pointer' }}>
        Export
      </button>
    </PageHeader>
  ),
}
