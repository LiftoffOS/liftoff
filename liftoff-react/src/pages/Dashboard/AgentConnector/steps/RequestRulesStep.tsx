import { useEffect, useState, useRef } from 'react'
import { Button } from '../../../../components'
import type { InternalAgent } from '../../../../services/internalAgents'
import {
  type TeamRequestRule,
  type RequestType,
  type RequestPermission,
  REQUEST_TYPES,
} from '../../../../services/externalAgents'
import ChevronDownIcon from '../../../../assets/icons/chevron-down.svg?react'

interface Props {
  teams: InternalAgent[]
  rules: TeamRequestRule[]
  onChange: (rules: TeamRequestRule[]) => void
  onConnect: () => void
  isLoading: boolean
}

const PERMISSIONS: RequestPermission[] = ['allowed', 'approval_required', 'blocked']

// Generate human-readable label for permission + request type
function getPermissionLabel(permission: RequestPermission, requestType: RequestType): string {
  const typeLabels: Record<RequestType, string> = {
    read_summaries: 'read summaries',
    run_analysis: 'run analysis',
    draft_outputs: 'draft outputs',
    propose_updates: 'propose updates',
  }

  const action = typeLabels[requestType]

  switch (permission) {
    case 'allowed':
      return `Can ${action}`
    case 'approval_required':
      return `Needs approval to ${action}`
    case 'blocked':
      return `Cannot ${action}`
  }
}

interface PermissionPillProps {
  permission: RequestPermission
  requestType: RequestType
  onChange: (permission: RequestPermission) => void
}

function PermissionPill({ permission, requestType, onChange }: PermissionPillProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="agent-connector__rules-pill-wrapper" ref={ref}>
      <button
        type="button"
        className={`agent-connector__rules-pill agent-connector__rules-pill--${permission}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {getPermissionLabel(permission, requestType)}
        <ChevronDownIcon className="agent-connector__rules-pill-chevron" />
      </button>
      {isOpen && (
        <div className="agent-connector__rules-dropdown">
          {PERMISSIONS.map(p => (
            <button
              key={p}
              type="button"
              className={`agent-connector__rules-dropdown-item agent-connector__rules-dropdown-item--${p} ${p === permission ? 'agent-connector__rules-dropdown-item--selected' : ''}`}
              onClick={() => {
                onChange(p)
                setIsOpen(false)
              }}
            >
              {getPermissionLabel(p, requestType)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RequestRulesStep({ teams, rules, onChange, onConnect, isLoading }: Props) {
  // Initialize rules for each team if not present
  useEffect(() => {
    const existingTeamIds = new Set(rules.map(r => r.teamId))
    const newRules: TeamRequestRule[] = [...rules]

    for (const team of teams) {
      if (!existingTeamIds.has(team.id)) {
        newRules.push({
          teamId: team.id,
          teamName: team.role,
          permissions: {
            read_summaries: 'allowed',
            run_analysis: 'allowed',
            draft_outputs: 'approval_required',
            propose_updates: 'approval_required',
          },
        })
      }
    }

    if (newRules.length !== rules.length) {
      onChange(newRules)
    }
  }, [teams, rules, onChange])

  const handlePermissionChange = (teamId: string, requestType: RequestType, permission: RequestPermission) => {
    const newRules = rules.map(rule => {
      if (rule.teamId === teamId) {
        return {
          ...rule,
          permissions: {
            ...rule.permissions,
            [requestType]: permission,
          },
        }
      }
      return rule
    })
    onChange(newRules)
  }

  return (
    <div className="agent-connector-step">
      <h1 className="agent-connector-step__header">What can this collaborator ask your team to do?</h1>

      {teams.length > 0 ? (
        <div className="agent-connector__rules-list">
          {rules.map(rule => (
            <div key={rule.teamId} className="agent-connector__rules-card">
              <h3 className="agent-connector__rules-card-name">{rule.teamName}</h3>
              <div className="agent-connector__rules-pills">
                {REQUEST_TYPES.map(type => (
                  <PermissionPill
                    key={type}
                    permission={rule.permissions[type]}
                    requestType={type}
                    onChange={(p) => handlePermissionChange(rule.teamId, type, p)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-sm)' }}>
          No teams selected. Go back to select teams.
        </p>
      )}

      <div className="agent-connector-nav">
        <Button
          variant="primary"
          onClick={onConnect}
          disabled={teams.length === 0}
          loading={isLoading}
        >
          Connect Collaborator
        </Button>
      </div>
    </div>
  )
}
