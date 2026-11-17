import type { Meta, StoryObj } from '@storybook/react'
import { AppProviders } from '../../.storybook/withAppProviders'
import RollbackModal from './RollbackModal'

const meta: Meta<typeof RollbackModal> = {
  title: 'Components/RollbackModal',
  component: RollbackModal,
  parameters: { layout: 'centered' },
  decorators: [
    // The version list goes through useTenant, which reads useAuth, so a query
    // client and a toast provider alone left this throwing on render.
    (Story) => (
      <AppProviders>
        <Story />
      </AppProviders>
    ),
  ],
  args: {
    entityType: 'team',
    entityId: 'team-abc-123',
    currentVersion: 3,
    onClose: () => console.log('close'),
  },
}

export default meta
type Story = StoryObj<typeof RollbackModal>

export const Default: Story = {}
