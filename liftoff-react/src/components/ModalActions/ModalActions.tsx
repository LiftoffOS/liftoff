import { ReactNode } from 'react'
import './ModalActions.css'

interface ModalActionsProps {
  children: ReactNode
}

export default function ModalActions({ children }: ModalActionsProps) {
  return (
    <div className="modal-actions">
      {children}
    </div>
  )
}
