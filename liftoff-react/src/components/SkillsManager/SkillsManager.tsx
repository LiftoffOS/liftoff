import { useState } from 'react'
import Button from '../Button'
import Tooltip from '../Tooltip'
import ActionMenu, { type ActionMenuItem } from '../ActionMenu/ActionMenu'
import LockIcon from '../../assets/icons/lock.svg?react'
import type { AgentSkill } from '../../services/internalAgents'
import './SkillsManager.css'

interface SkillsManagerProps {
  skills: AgentSkill[]
  /** Persisted through the normal team update, so an edit lands as a manual
   *  version with rollback like every other change. */
  onChange: (skills: AgentSkill[]) => void
  disabled?: boolean
}

/**
 * Steering controls for what a team member has learned (P1.4).
 *
 * One display, not two: every skill is a pill in the "Uses" row and the pill
 * carries its own ActionMenu, the same one the teams page uses. Three verbs,
 * deliberately no more:
 *   Edit      — change the instruction. Editing takes ownership, so the
 *               reflection loop stops rewriting it afterwards.
 *   Preserve  — take ownership without changing anything.
 *   Archive   — retire a skill without losing it. Archived skills leave the
 *               runtime but stay here, restorable.
 *
 * Only Edit opens anything: the editor card drops in under the pills. Someone
 * who never opens Advanced Settings never meets any of this, which is the point.
 */
export default function SkillsManager({ skills, onChange, disabled = false }: SkillsManagerProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const keyOf = (skill: AgentSkill) => skill.id ?? skill.name
  const active = skills.filter(s => !s.archived)
  const archived = skills.filter(s => s.archived)
  const editingSkill = editing ? skills.find(s => keyOf(s) === editing) ?? null : null

  const replaceSkill = (target: AgentSkill, changes: Partial<AgentSkill>) => {
    onChange(skills.map(s => (keyOf(s) === keyOf(target) ? { ...s, ...changes } : s)))
  }

  const startEdit = (skill: AgentSkill) => {
    setEditing(keyOf(skill))
    setDraft(skill.instruction)
  }

  const cancelEdit = () => {
    setEditing(null)
    setDraft('')
  }

  const saveEdit = (skill: AgentSkill) => {
    const instruction = draft.trim()
    if (instruction && instruction !== skill.instruction) {
      // An edit makes it the person's: provenance flips and it is preserved,
      // so nothing rewrites it behind them.
      replaceSkill(skill, { instruction, provenance: 'operator', protected: true })
    }
    cancelEdit()
  }

  const menuItems = (skill: AgentSkill): ActionMenuItem[] => {
    if (skill.archived) {
      return [{ label: 'Restore', onClick: () => replaceSkill(skill, { archived: false }) }]
    }
    return [
      { label: 'Edit', onClick: () => startEdit(skill) },
      {
        label: skill.protected ? 'Allow updates' : 'Preserve',
        onClick: () => replaceSkill(skill, skill.protected
          ? { protected: false }
          : { protected: true, provenance: 'operator' }),
      },
      {
        label: 'Archive',
        onClick: () => {
          if (editing === keyOf(skill)) cancelEdit()
          replaceSkill(skill, { archived: true })
        },
      },
    ]
  }

  const renderChip = (skill: AgentSkill) => {
    const key = keyOf(skill)

    const chipClasses = [
      'skills-manager__chip',
      skill.archived ? 'skills-manager__chip--archived' : '',
      editing === key ? 'skills-manager__chip--editing' : '',
    ].filter(Boolean).join(' ')

    return (
      <div key={key} className={chipClasses}>
        <Tooltip text={skill.description || skill.name} position="top">
          <span className="skills-manager__chip-label">
            {skill.protected && (
              <LockIcon className="skills-manager__chip-lock" aria-hidden="true" focusable="false" />
            )}
            <span className="skills-manager__chip-name">{skill.name}</span>
            {skill.protected && <span className="sr-only">Preserved</span>}
          </span>
        </Tooltip>

        <ActionMenu
          items={menuItems(skill)}
          disabled={disabled}
          ariaLabel={`Actions for ${skill.name}`}
        />
      </div>
    )
  }

  if (skills.length === 0) return null

  return (
    <div className="skills-manager">
      {active.length > 0 && (
        <div className="skills-manager__uses">
          <span className="skills-manager__uses-label">Uses</span>
          <div className="skills-manager__chips">{active.map(renderChip)}</div>
        </div>
      )}

      {editingSkill && (
        <div className="skills-manager__editor">
          <div className="skills-manager__editor-head">
            <span className="skills-manager__editor-name">{editingSkill.name}</span>
            {editingSkill.description && (
              <span className="skills-manager__editor-description">{editingSkill.description}</span>
            )}
          </div>
          <textarea
            className="skills-manager__textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={6}
            disabled={disabled}
            aria-label={`Instruction for ${editingSkill.name}`}
          />
          <div className="skills-manager__editor-actions">
            <Button variant="text" onClick={cancelEdit} disabled={disabled}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => saveEdit(editingSkill)} disabled={disabled}>
              Save
            </Button>
          </div>
        </div>
      )}

      {archived.length > 0 && (
        <div className="skills-manager__archived">
          <button
            type="button"
            className="skills-manager__archived-toggle"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="skills-manager__chips skills-manager__chips--archived">
              {archived.map(renderChip)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
