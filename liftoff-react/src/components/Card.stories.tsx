import type { Meta, StoryObj } from '@storybook/react-vite'
import Card from './Card'
import ClockIcon from '../assets/icons/clock.svg?react'
import PeopleIcon from '../assets/icons/people.svg?react'

const meta: Meta<typeof Card> = {
  title: 'Atomic/Card',
  component: Card,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof Card>

export const Default: Story = {
  args: {
    title: 'Card Title',
    description: 'This is a description for the card component.',
  },
}

export const WithIcon: Story = {
  args: {
    title: 'Launch Instantly',
    description: 'Stand up new agents in minutes, ready to begin working immediately.',
    icon: <ClockIcon />,
  },
}

export const WithCustomIconClass: Story = {
  args: {
    title: 'Augment with Experts',
    description: 'Bring on human experts to improve the team\'s performance.',
    icon: <PeopleIcon />,
    iconClassName: 'card__icon--experts',
  },
}
