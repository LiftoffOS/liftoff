// The calls a HITL approval is holding, rendered for a person.
//
// This is the approver's trust anchor: the generated Action line above it is
// advisory prose, and this is what the agent will actually run. It is built
// from the structured `pendingToolCalls` rather than the runtime's flattened
// `detail` string, so every argument is present, labelled, and written out
// instead of arriving as a truncated JSON blob.

import { useState } from 'react'
import type { PendingToolCall } from '../../../services/oversight'
import { describeToolCall, redactSecrets, toDetailFields } from '../../../utils/toolCallDetails'
import { editableFieldsOf, withEditedFields } from '../../../utils/editableToolInput'

interface ToolCallDetailsProps {
  calls: PendingToolCall[]
  /** Called when the reader changes an argument, with the call's whole new
   *  input. Omitted on a read-only surface, which is what hides the editor:
   *  a card with nowhere to send an edit must not offer one. */
  onEdit?: (callId: string, input: Record<string, unknown>) => void
  /** Edits made so far, keyed by call id, so the fields survive a re-render and
   *  a reader can see what they have already changed.
   *
   *  On a decided approval this is the approver's RECORDED version rather than
   *  a draft, which is why `editsAreRecorded` exists: the same shape means two
   *  different things, and only one of them belongs in an audit trail. */
  edits?: Record<string, Record<string, unknown>>
  /** True when `edits` came back from the server as what was actually sent.
   *  The card says so, because an approval that reads exactly like the agent's
   *  draft when a person rewrote it first misreports what the review did. */
  editsAreRecorded?: boolean
}

export function ToolCallDetails({ calls, onEdit, edits, editsAreRecorded }: ToolCallDetailsProps) {
  if (calls.length === 0) return null
  return (
    <div className="tool-calls-list">
      {calls.map((call) => (
        <ToolCallCard
          key={call.id}
          call={call}
          onEdit={onEdit}
          editedInput={edits?.[call.id]}
          editsAreRecorded={editsAreRecorded}
        />
      ))}
    </div>
  )
}

function ToolCallCard({
  call,
  onEdit,
  editedInput,
  editsAreRecorded,
}: {
  call: PendingToolCall
  onEdit?: (callId: string, input: Record<string, unknown>) => void
  editedInput?: Record<string, unknown>
  editsAreRecorded?: boolean
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const { connector, action } = describeToolCall(call.name)
  // What is shown, and what an edit is applied on top of: the reader's own
  // version once they have made one, so a second edit builds on the first.
  const current = editedInput ?? call.input
  const fields = toDetailFields(current)
  const editable = editableFieldsOf(current)

  return (
    <div className="tool-call">
      <div className="tool-call__header">
        <span className="tool-call__name">
          {connector ? (
            <>
              <span className="tool-call__connector">{connector}</span>
              <span className="tool-call__separator" aria-hidden="true">
                {'·'}
              </span>
            </>
          ) : null}
          <span className="tool-call__action">{action}</span>
          {editsAreRecorded && editedInput ? (
            <span className="tool-call__edited">Changed by the approver</span>
          ) : null}
        </span>
        {/* Editing is offered only where there is something a person can
            sensibly change and somewhere to send it. A call whose arguments are
            all ids and nested structures gets the read-only card it always had:
            an editor over those invites a broken request, not a better one. */}
        {onEdit && editable.length > 0 ? (
          <button
            type="button"
            className="tool-call__raw-toggle"
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? 'Done editing' : 'Edit'}
          </button>
        ) : null}
        <button
          type="button"
          className="tool-call__raw-toggle"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((open) => !open)}
        >
          {showRaw ? 'Hide request' : 'View request'}
        </button>
      </div>

      {editing && onEdit ? (
        <div className="tool-call__fields">
          {editable.map((field) => (
            <div key={field.path} className="tool-call__field">
              <label className="tool-call__field-label" htmlFor={`${call.id}-${field.path}`}>
                {field.label}
              </label>
              {field.multiline ? (
                <textarea
                  id={`${call.id}-${field.path}`}
                  className="tool-call__field-input"
                  rows={5}
                  value={field.value}
                  onChange={(e) =>
                    onEdit(call.id, withEditedFields(current, field.path, e.target.value))
                  }
                />
              ) : (
                <input
                  id={`${call.id}-${field.path}`}
                  type="text"
                  className="tool-call__field-input"
                  value={field.value}
                  onChange={(e) =>
                    onEdit(call.id, withEditedFields(current, field.path, e.target.value))
                  }
                />
              )}
            </div>
          ))}
        </div>
      ) : null}

      {!editing && fields.length > 0 && (
        <div className="tool-call__fields">
          {fields.map((field) => (
            <div
              key={field.path}
              className={`tool-call__field tool-call__field--depth-${field.depth} ${
                field.value === null ? 'tool-call__field--group' : ''
              }`.trim()}
            >
              <span className="tool-call__field-label">{field.label}</span>
              {field.value !== null && (
                <span className="tool-call__field-value">{field.value}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The exact payload, for the reader who wants to check the rows against
          it. Secret-bearing keys are replaced first: the queue serves the raw
          input, and only the runtime's flattened line was ever redacted. */}
      {showRaw && (
        <pre className="tool-call__input">
          {JSON.stringify(redactSecrets(current), null, 2)}
        </pre>
      )}
    </div>
  )
}
