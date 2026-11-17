import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import ModalOverlay from './ModalOverlay'
import Button from './Button'

const meta: Meta<typeof ModalOverlay> = {
  title: 'UI/ModalOverlay',
  component: ModalOverlay,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
}

export default meta
type Story = StoryObj<typeof ModalOverlay>

export const Default: Story = {
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false)
    return (
      <>
        <Button onClick={() => setIsOpen(true)}>Open Modal</Button>
        {isOpen && (
          <ModalOverlay onClose={() => setIsOpen(false)}>
            <div style={{ padding: '24px', maxWidth: '400px' }}>
              <h2 id="modal-title" style={{ marginBottom: '16px' }}>Modal Title</h2>
              <p style={{ marginBottom: '24px' }}>This is the modal content. Click outside or press Escape to close.</p>
              <Button onClick={() => setIsOpen(false)}>Close</Button>
            </div>
          </ModalOverlay>
        )}
      </>
    )
  },
}

export const WithAriaLabel: Story = {
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false)
    return (
      <>
        <Button onClick={() => setIsOpen(true)}>Open Labeled Modal</Button>
        {isOpen && (
          <ModalOverlay onClose={() => setIsOpen(false)} ariaLabelledBy="modal-heading">
            <div style={{ padding: '24px', maxWidth: '400px' }}>
              <h2 id="modal-heading" style={{ marginBottom: '16px' }}>Confirm Action</h2>
              <p style={{ marginBottom: '24px' }}>Are you sure you want to proceed?</p>
              <div style={{ display: 'flex', gap: '12px' }}>
                <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button onClick={() => setIsOpen(false)}>Confirm</Button>
              </div>
            </div>
          </ModalOverlay>
        )}
      </>
    )
  },
}

export const DisableClose: Story = {
  render: function Render() {
    const [isOpen, setIsOpen] = useState(false)
    return (
      <>
        <Button onClick={() => setIsOpen(true)}>Open Non-Dismissible Modal</Button>
        {isOpen && (
          <ModalOverlay onClose={() => setIsOpen(false)} disableClose>
            <div style={{ padding: '24px', maxWidth: '400px' }}>
              <h2 style={{ marginBottom: '16px' }}>Required Action</h2>
              <p style={{ marginBottom: '24px' }}>You must click the button to close this modal. Clicking outside or pressing Escape will not work.</p>
              <Button onClick={() => setIsOpen(false)}>I Understand</Button>
            </div>
          </ModalOverlay>
        )}
      </>
    )
  },
}
