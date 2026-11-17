import { useState, useEffect, type ReactNode } from 'react'
import {
  OnboardingContext,
  type OnboardingState,
  type OnboardingContextType,
  type OnboardingTeam,
  type BusinessContextData,
  type ReviewModelData,
  type OnboardingData,
} from './OnboardingContext'

const STORAGE_KEY = 'onboarding-state'

const defaultTeam: OnboardingTeam = {
  executiveSponsor: null,
  itContact: null,
  workflowOwner: null,
  reviewerLead: null,
  approvers: []
}

const defaultBusinessContext: BusinessContextData = {
  inboundSources: [],
  serviceLines: [],
  routingRules: [],
  exceptions: [],
  terminology: {}
}

const defaultReviewModel: ReviewModelData = {
  mode: 'hybrid',
  confidenceThresholds: {
    autoApprove: 85,
    reviewRequired: 60,
    escalate: 40
  },
  sensitiveActions: []
}

const defaultData: OnboardingData = {
  team: defaultTeam,
  connectedIntegrations: [],
  selectedWorkflowPackage: null,
  businessContext: defaultBusinessContext,
  reviewModel: defaultReviewModel
}

const defaultState: OnboardingState = {
  currentStep: 1,
  completedSteps: [],
  data: defaultData
}

function loadFromStorage(): OnboardingState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.error('Failed to load onboarding state:', e)
  }
  return defaultState
}

function saveToStorage(state: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('Failed to save onboarding state:', e)
  }
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OnboardingState>(loadFromStorage)

  useEffect(() => {
    saveToStorage(state)
  }, [state])

  const setCurrentStep = (step: number) => {
    setState(prev => ({ ...prev, currentStep: step }))
  }

  const markStepComplete = (step: number) => {
    setState(prev => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step)
        ? prev.completedSteps
        : [...prev.completedSteps, step].sort((a, b) => a - b)
    }))
  }

  const updateData = <K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) => {
    setState(prev => ({
      ...prev,
      data: { ...prev.data, [key]: value }
    }))
  }

  const resetOnboarding = () => {
    setState(defaultState)
    localStorage.removeItem(STORAGE_KEY)
  }

  const isStepComplete = (step: number) => {
    return state.completedSteps.includes(step)
  }

  const canNavigateToStep = (step: number) => {
    if (step === 1) return true
    // Can navigate to any completed step or the next uncompleted step
    const maxCompleted = Math.max(0, ...state.completedSteps)
    return step <= maxCompleted + 1
  }

  const value: OnboardingContextType = {
    state,
    currentStep: state.currentStep,
    completedSteps: state.completedSteps,
    data: state.data,
    setCurrentStep,
    markStepComplete,
    updateData,
    resetOnboarding,
    isStepComplete,
    canNavigateToStep
  }

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  )
}
