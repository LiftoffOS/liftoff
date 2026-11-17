import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import WorkflowCard from './WorkflowCard'

const meta: Meta<typeof WorkflowCard> = {
  title: 'Dashboard/WorkflowCard',
  component: WorkflowCard,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof WorkflowCard>

export const Default: Story = {
  args: {
    id: 'workflow-1',
    name: 'Invoice Processing',
    volume: 1234,
    medianTime: '2.5 min',
    automationRate: 85,
    reviewRate: 10,
    exceptionRate: 5,
    trend: 12,
  },
}

export const HighAutomation: Story = {
  args: {
    id: 'workflow-2',
    name: 'Document Classification',
    volume: 5678,
    medianTime: '30 sec',
    automationRate: 95,
    reviewRate: 4,
    exceptionRate: 1,
    trend: 25,
  },
}

export const LowAutomation: Story = {
  args: {
    id: 'workflow-3',
    name: 'Contract Review',
    volume: 234,
    medianTime: '15 min',
    automationRate: 45,
    reviewRate: 40,
    exceptionRate: 15,
    trend: -5,
  },
}

export const NegativeTrend: Story = {
  args: {
    id: 'workflow-4',
    name: 'Customer Onboarding',
    volume: 89,
    medianTime: '5 min',
    automationRate: 70,
    reviewRate: 20,
    exceptionRate: 10,
    trend: -8,
  },
}

export const HighVolume: Story = {
  args: {
    id: 'workflow-5',
    name: 'Email Triage',
    volume: 45678,
    medianTime: '5 sec',
    automationRate: 92,
    reviewRate: 6,
    exceptionRate: 2,
    trend: 18,
  },
}
