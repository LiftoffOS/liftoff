import type { Meta, StoryObj } from '@storybook/react'
import WaveBackground from './WaveBackground'

const meta: Meta<typeof WaveBackground> = {
  title: 'Marketing/WaveBackground',
  component: WaveBackground,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof WaveBackground>

export const Default: Story = {}
