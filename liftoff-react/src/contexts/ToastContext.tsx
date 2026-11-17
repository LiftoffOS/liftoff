import { createContext, useContext } from 'react'
import type { ToastType } from '../components/common/Toast'

export interface ToastContextValue {
  showToast: (message: string, type: ToastType, duration?: number) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
