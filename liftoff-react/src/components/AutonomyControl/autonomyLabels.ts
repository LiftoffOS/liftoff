import type { AutonomyLevel } from '../../services/oversight'

// Shared with the collapsed-card badge on AgentUpdatePage so the two never drift.
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  autonomous: 'More autonomous',
  balanced: 'Balanced',
  controlled: 'More controlled',
}
