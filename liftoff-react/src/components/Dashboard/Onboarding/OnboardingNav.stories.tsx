import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router'
import { OnboardingProvider } from '../../../contexts/OnboardingProvider'
import OnboardingNav from './OnboardingNav'

const meta: Meta<typeof OnboardingNav> = {
  title: 'Components/Dashboard/Onboarding/OnboardingNav',
  component: OnboardingNav,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <OnboardingProvider>
          <Story />
        </OnboardingProvider>
      </MemoryRouter>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof OnboardingNav>

export const Default: Story = {
  args: {
    canProceed: true,
  },
}

export const CannotProceed: Story = {
  args: {
    canProceed: false,
  },
}

export const WithOnCompleteCallback: Story = {
  args: {
    canProceed: true,
    onComplete: () => alert('Setup complete!'),
  },
}
