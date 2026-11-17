import type { Meta, StoryObj } from '@storybook/react'
import ModalActions from './ModalActions'
import Button from '../Button'

const meta: Meta<typeof ModalActions> = {
  title: 'Components/ModalActions',
  component: ModalActions,
  parameters: {
    layout: 'centered',
  },
  decorators: [(Story) => <div style={{ width: 400 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof ModalActions>

export const Default: Story = {
  render: () => (
    <ModalActions>
      <Button variant="outline" size="sm">Cancel</Button>
      <Button variant="primary" size="sm">Confirm</Button>
    </ModalActions>
  ),
}

export const ThreeButtons: Story = {
  render: () => (
    <ModalActions>
      <Button variant="outline" size="sm">Cancel</Button>
      <Button variant="outline" size="sm">Back</Button>
      <Button variant="primary" size="sm">Next</Button>
    </ModalActions>
  ),
}
