// Storybook stories for KnowledgeMentionChip — the React NodeView TipTap
// uses to render [[knowledge:...]] mentions inside MarkdownTextarea.
//
// Stories cover the three rendering states:
//   1. healthy chip (item exists + connector bound, or manual URL)
//   2. broken — item deleted from knowledge_items
//   3. broken — connector no longer bound to the agent
//
// The component reads its broken-state inputs from KnowledgeChipContext, so
// stories provide an explicit provider rather than fabricating attrs.

import type { Meta, StoryObj } from '@storybook/react-vite'
import type { NodeViewProps } from '@tiptap/core'
import {
  KnowledgeMentionChip,
} from './KnowledgeMentionChip'
import { KnowledgeChipContext, type ChipContextValue } from './knowledgeChipContext'
import './MarkdownTextarea.css'

function fakeNodeViewProps(id: string, label: string): NodeViewProps {
  return { node: { attrs: { id, label } } } as unknown as NodeViewProps
}

const baseCtx: ChipContextValue = {
  availableItemIds: new Set(['k1', 'k2']),
  boundConnectorIds: new Set(['c-zendesk']),
  itemConnectorMap: new Map([
    ['k1', 'c-zendesk'],
    ['k2', null], // manual URL
  ]),
}

const meta: Meta<typeof KnowledgeMentionChip> = {
  title: 'Editor/KnowledgeMentionChip',
  component: KnowledgeMentionChip,
  decorators: [
    (Story, { args }) => (
      <KnowledgeChipContext.Provider value={(args as { ctx?: ChipContextValue }).ctx ?? baseCtx}>
        <div style={{ padding: 24, fontSize: 16 }}>
          <p>Lorem ipsum <Story /> dolor sit amet.</p>
        </div>
      </KnowledgeChipContext.Provider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof KnowledgeMentionChip>

export const Healthy: Story = {
  args: fakeNodeViewProps('k1', 'Password Reset Guide'),
}

export const ManualUrlItem: Story = {
  args: fakeNodeViewProps('k2', 'Onboarding URL'),
}

export const BrokenItemDeleted: Story = {
  args: {
    ...fakeNodeViewProps('k-missing', 'Deleted Article'),
    // @ts-expect-error story-only override consumed by the decorator
    ctx: {
      availableItemIds: new Set(),
      boundConnectorIds: new Set(['c-zendesk']),
      itemConnectorMap: new Map(),
    } satisfies ChipContextValue,
  },
}

export const BrokenConnectorRemoved: Story = {
  args: {
    ...fakeNodeViewProps('k1', 'Refund Policy'),
    // @ts-expect-error story-only override consumed by the decorator
    ctx: {
      availableItemIds: new Set(['k1']),
      boundConnectorIds: new Set(), // operator removed Zendesk
      itemConnectorMap: new Map([['k1', 'c-zendesk']]),
    } satisfies ChipContextValue,
  },
}
