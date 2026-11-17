import type { AutonomyLevel } from '../../services/oversight'
import StatusBadge from '../StatusBadge'
import './AutonomyControl.css'
import { AUTONOMY_LABELS } from './autonomyLabels'

interface AutonomyControlProps {
  value: AutonomyLevel | null
  onChange: (level: AutonomyLevel | null) => void
  /** The workspace-level autonomy this agent inherits, once resolved. The
   *  matching option is badged, and choosing it means "inherit" (null) rather
   *  than pinning that level. Omitted while the oversight query is loading. */
  workspaceDefault?: AutonomyLevel
}

// There are only three real autonomy levels. "Inherit" is not a fourth one: it
// is whichever of these three the workspace is set to, so it is rendered as a
// badge on that option rather than as a separate row duplicating it.
const options: Array<{ level: AutonomyLevel; description: string }> = [
  {
    level: 'autonomous',
    description: 'Handle most work independently, escalate only when needed',
  },
  {
    level: 'balanced',
    description: 'Work independently, escalate important or sensitive decisions',
  },
  {
    level: 'controlled',
    description: 'Escalate more often for visibility and oversight',
  },
]

export function AutonomyControl({ value, onChange, workspaceDefault }: AutonomyControlProps) {
  // A null override shows as the workspace's own level being selected. Until
  // that level is known, nothing is highlighted rather than guessing wrong.
  const selected = value ?? workspaceDefault ?? null

  return (
    <div className="autonomy-control">
      {options.map((opt) => {
        const isWorkspaceDefault = opt.level === workspaceDefault
        return (
          <button
            key={opt.level}
            type="button"
            className={`autonomy-control__option${selected === opt.level ? ' autonomy-control__option--active' : ''}`}
            // Choosing the workspace's own level means "follow the workspace",
            // so it clears the override instead of pinning the same value.
            onClick={() => onChange(isWorkspaceDefault ? null : opt.level)}
          >
            <span className="autonomy-control__label-row">
              <span className="autonomy-control__label">{AUTONOMY_LABELS[opt.level]}</span>
              {isWorkspaceDefault && <StatusBadge variant="neutral">Workspace Default</StatusBadge>}
            </span>
            <span className="autonomy-control__description">{opt.description}</span>
          </button>
        )
      })}
    </div>
  )
}
