import { createContext, useContext } from 'react'

export interface TeamMember {
  name: string
  email: string
  role?: string
}

export interface OnboardingTeam {
  executiveSponsor: TeamMember | null
  itContact: TeamMember | null
  workflowOwner: TeamMember | null
  reviewerLead: TeamMember | null
  approvers: TeamMember[]
}

export interface BusinessContextData {
  inboundSources: string[]
  serviceLines: string[]
  routingRules: string[]
  exceptions: string[]
  terminology: Record<string, string>
}

export interface ReviewModelData {
  mode: 'auto' | 'hybrid' | 'review-only'
  confidenceThresholds: {
    autoApprove: number
    reviewRequired: number
    escalate: number
  }
  sensitiveActions: string[]
}

export interface OnboardingData {
  team: OnboardingTeam
  connectedIntegrations: string[]
  selectedWorkflowPackage: string | null
  businessContext: BusinessContextData
  reviewModel: ReviewModelData
}

export interface OnboardingState {
  currentStep: number
  completedSteps: number[]
  data: OnboardingData
}

export interface OnboardingContextType {
  state: OnboardingState
  currentStep: number
  completedSteps: number[]
  data: OnboardingData
  setCurrentStep: (step: number) => void
  markStepComplete: (step: number) => void
  updateData: <K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) => void
  resetOnboarding: () => void
  isStepComplete: (step: number) => boolean
  canNavigateToStep: (step: number) => boolean
}

export const OnboardingContext = createContext<OnboardingContextType | null>(null)

export function useOnboarding() {
  const context = useContext(OnboardingContext)
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider')
  }
  return context
}
