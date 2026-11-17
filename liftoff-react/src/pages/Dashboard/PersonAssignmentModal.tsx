import { useState, useMemo } from 'react'
import { Button, Checkbox, ModalActions, ModalOverlay, TextInput } from '../../components'
import { useUpdatePersonAssignments } from '../../hooks/usePersonAssignments'
import { useToast } from '../../contexts/ToastContext'
import type { PersonnelMember } from '../../services/personAssignments'
import type { InternalAgent } from '../../services/internalAgents'
import type { ExternalAgent } from '../../services/externalAgents'
import { useAutoFocus } from '../../hooks/useAutoFocus'

interface PersonAssignmentModalProps {
  person: PersonnelMember
  internalAgents: InternalAgent[]
  externalAgents: ExternalAgent[]
  onClose: () => void
}

export default function PersonAssignmentModal({
  person,
  internalAgents,
  externalAgents,
  onClose,
}: PersonAssignmentModalProps) {
  const searchRef = useAutoFocus<HTMLInputElement>()
  const { showToast } = useToast()
  const updateMutation = useUpdatePersonAssignments()
  const [search, setSearch] = useState('')

  // Map<agentId, agentType> for current selections
  const [selected, setSelected] = useState<Map<string, 'internal' | 'external'>>(() => {
    const map = new Map<string, 'internal' | 'external'>()
    for (const a of person.assignments) {
      map.set(a.agentId, a.agentType)
    }
    return map
  })

  // Filter to non-archived agents for selection
  const selectableInternal = internalAgents.filter(a => a.status !== 'paused')
  const selectableExternal = externalAgents.filter(a => a.status !== 'disconnected' && a.status !== 'error')

  // Search filtering
  const query = search.toLowerCase().trim()
  const filteredInternal = useMemo(() =>
    query ? selectableInternal.filter(a => a.role.toLowerCase().includes(query)) : selectableInternal,
    [selectableInternal, query]
  )
  const filteredExternal = useMemo(() =>
    query ? selectableExternal.filter(a => a.name.toLowerCase().includes(query)) : selectableExternal,
    [selectableExternal, query]
  )

  // Assignments to agents that are archived/unavailable (show read-only)
  const archivedAssignments = person.assignments.filter(a => {
    if (a.agentType === 'internal') return !selectableInternal.some(ia => ia.id === a.agentId)
    if (a.agentType === 'external') return !selectableExternal.some(ea => ea.id === a.agentId)
    return false
  })

  const toggleAgent = (agentId: string, agentType: 'internal' | 'external') => {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        next.set(agentId, agentType)
      }
      return next
    })
  }

  const handleSave = () => {
    const assignments = Array.from(selected.entries()).map(([agentId, agentType]) => ({
      agentId,
      agentType,
    }))

    updateMutation.mutate(
      { accountId: person.accountId, assignments },
      {
        onSuccess: () => {
          showToast(`Updated assignments for ${person.firstName} ${person.lastName}`, 'success')
          onClose()
        },
        onError: () => {
          showToast('Failed to update assignments', 'error')
        },
      }
    )
  }

  const titleId = 'assignment-modal-title'
  const hasNoAgents = selectableInternal.length === 0 && selectableExternal.length === 0
  const hasNoResults = query && filteredInternal.length === 0 && filteredExternal.length === 0
  const selectedCount = selected.size

  return (
    <ModalOverlay onClose={onClose}>
      <div className="assignment-modal" role="dialog" aria-labelledby={titleId}>
        <h2 id={titleId} className="assignment-modal__title">
          Update Assignment for {person.firstName} {person.lastName}
        </h2>
        <p className="assignment-modal__description">
          Select who this person should be assigned to.
        </p>

        {!hasNoAgents && (
          <TextInput
            variant="search"
            placeholder="Search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            ref={searchRef}
          />
        )}

        <div className="assignment-modal__list">
          {hasNoAgents && (
            <p className="assignment-modal__empty">Nothing available for assignment.</p>
          )}

          {hasNoResults && (
            <p className="assignment-modal__empty">Nothing matching "{search}"</p>
          )}

          {filteredInternal.length > 0 && (
            <fieldset className="assignment-modal__section">
              <legend className="assignment-modal__section-title">agents</legend>
              {filteredInternal.map(agent => (
                <Checkbox
                  key={agent.id}
                  label={agent.role}
                  checked={selected.has(agent.id)}
                  onChange={() => toggleAgent(agent.id, 'internal')}
                  disabled={updateMutation.isPending}
                />
              ))}
            </fieldset>
          )}

          {filteredExternal.length > 0 && (
            <fieldset className="assignment-modal__section">
              <legend className="assignment-modal__section-title">External Agents</legend>
              {filteredExternal.map(agent => (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  checked={selected.has(agent.id)}
                  onChange={() => toggleAgent(agent.id, 'external')}
                  disabled={updateMutation.isPending}
                />
              ))}
            </fieldset>
          )}

          {archivedAssignments.length > 0 && !query && (
            <div className="assignment-modal__section">
              <p className="assignment-modal__section-title">Existing (unavailable agents)</p>
              {archivedAssignments.map(a => (
                <Checkbox
                  key={a.agentId}
                  label={a.agentName}
                  checked={true}
                  onChange={() => {}}
                  disabled
                />
              ))}
            </div>
          )}
        </div>

        <ModalActions>
          <span className="assignment-modal__count">{selectedCount} selected</span>
          <Button variant="outline" size="sm" onClick={onClose} disabled={updateMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={updateMutation.isPending}
            onClick={handleSave}
          >
            {updateMutation.isPending ? 'Saving...' : 'Update'}
          </Button>
        </ModalActions>
      </div>
    </ModalOverlay>
  )
}
