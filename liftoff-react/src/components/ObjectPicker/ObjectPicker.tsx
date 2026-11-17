// Name one thing inside the customer's own workspace: which channel to post to,
// which folder to write into, which list to read from.
//
// WHY THIS EXISTS
// Connecting a tool and knowing where to put things are different facts, and the
// explore flow only ever collected the first. It bound Slack and then handed the
// distiller prose saying "post the alert to the finance channel", so the compiled
// team had no channel and nobody was ever asked which one. 127 phrases across 45
// templates depend on a destination nobody supplies.
//
// ONE PATH, MANY KINDS
// Every kind resolves through the same browse endpoint, which already accepts an
// `entityType` and already serves more than files: Slack answers `channels` from
// conversations.list, and Zendesk/Intercom drive their own hierarchy levels. So
// adding a kind is an entry in KIND_CONFIG below plus whatever the connector
// already enumerates — not a new flow, not a new endpoint, not a new modal.
//
// Folders and files keep FilePicker, which browses hierarchies and is already
// proven on the knowledge page. Flat kinds (channels, tables) render a list,
// because a channel has no children to expand into.
//
// NOT KNOWLEDGE
// What comes back is a team-scoped binding that feeds this hire's distillation.
// It is deliberately NOT a knowledge item: pointing an analyst at your competitor
// list says nothing about wanting that document in the workspace repository,
// which is a separate, opt-in decision made on the completion screen.

import { useEffect, useState } from 'react'
import ModalOverlay from '../ModalOverlay'
import Button from '../Button'
import FilePicker from '../FilePicker/FilePicker'
import { useBrowseConnector } from '../../hooks/useKnowledge'
import type { BrowseResult } from '../../services/knowledge'
import type { RequirementObject, RequirementObjectKind } from '../../services/agentTemplates'
import './ObjectPicker.css'

/** What the chosen thing is, in the shape the connector binding stores. */
export interface PickedObject {
  id: string
  title: string
  /** What was actually chosen, when the question accepted either.
   *
   *  A destination takes a folder OR a file and they mean different things —
   *  a folder is a place to work in, a file is the deliverable itself — so the
   *  answer has to say which it was. Absent for every other kind, where the
   *  question already fixes it. */
  kind?: 'folder' | 'file'
}

interface KindConfig {
  /** Forwarded to the browse endpoint so the connector knows what to list. */
  entityType?: string
  /** Hierarchical kinds browse with FilePicker; flat kinds render a list. */
  hierarchical: boolean
  /** The heading. Short and about the ACT, matching "Select files from Google
   *  Drive" on the knowledge page, so both read as the same kind of question. */
  heading: (connectorName: string) => string
  /** Used underneath when a template supplies no label of its own. */
  fallbackTitle: string
  emptyMessage: string
}

const KIND_CONFIG: Record<RequirementObjectKind, KindConfig> = {
  destination: {
    hierarchical: true,
    // "Select a folder or file in X", matching the folder, file and channel
    // headings beside it. It said "Choose where this team saves its work in X",
    // which is one template's purpose written into a control every template
    // uses: a destination is not always a save location, and the question's own
    // label already says what this one is for.
    heading: (c) => `Select a folder or file in ${c}`,
    fallbackTitle: 'Choose a folder or a file.',
    emptyMessage: 'Nothing found to choose from.',
  },
  folder: {
    hierarchical: true,
    heading: (c) => `Select a folder in ${c}`,
    fallbackTitle: 'Choose where this team writes.',
    emptyMessage: 'No folders found.',
  },
  file: {
    hierarchical: true,
    heading: (c) => `Select a file from ${c}`,
    fallbackTitle: 'Choose what this team reads.',
    emptyMessage: 'No files found.',
  },
  channel: {
    entityType: 'channels',
    hierarchical: false,
    heading: (c) => `Select a channel in ${c}`,
    fallbackTitle: 'Choose where this team posts.',
    emptyMessage: 'No channels found. Check that the connection can see them.',
  },
  table: {
    entityType: 'tables',
    hierarchical: false,
    heading: (c) => `Select a table in ${c}`,
    fallbackTitle: 'Choose where this team writes.',
    // Reached only when the connector reported a real, enumerable empty. A
    // provider that cannot list tables sends `unsupported` instead and gets
    // different wording, so this can say "none" plainly without risking
    // blaming a workspace for a gap of ours.
    emptyMessage: 'No tables found in this connection.',
  },
}

interface ObjectPickerProps {
  /** Everything this connection needs named. More than one only happens for the
   *  hierarchical kinds, where a single tree can answer them all at once. */
  objects: RequirementObject[]
  connectorId: string
  connectorName: string
  /** What is already chosen, keyed by object id, so reopening shows the current
   *  answers rather than looking like a fresh question. */
  current?: Record<string, PickedObject | null>
  onPick: (objectId: string, picked: PickedObject) => void
  /** Fires when the connection cannot enumerate this kind at all, so there is
   *  nothing to pick from. The modal says a person may continue without
   *  picking; this is what lets the step honour that, instead of leaving a
   *  required pick unanswerable and the Continue button dead. */
  onUnsupported?: (objectId: string) => void
  onClose: () => void
}

export default function ObjectPicker({
  objects,
  connectorId,
  connectorName,
  current,
  onPick,
  onUnsupported,
  onClose,
}: ObjectPickerProps) {
  // One tree answers every hierarchical pick in a single pass. A row is routed
  // by what it is: a folder answers the folder pick, a file answers the file
  // pick. Safe because no connector asks for two picks of the same kind.
  const object = objects[0]
  const config = KIND_CONFIG[object.kind]
  const [selected, setSelected] = useState<PickedObject | null>(
    current?.[object.id] ?? null,
  )

  const hierarchical = objects.filter(o => KIND_CONFIG[o.kind].hierarchical)
  const folderPick = hierarchical.find(o => o.kind === 'folder')
  const filePick = hierarchical.find(o => o.kind === 'file')
  const destinationPickLabel = hierarchical.find(o => o.kind === 'destination')?.label

  return (
    <ModalOverlay onClose={onClose}>
      {/* Short, and the same shape as the knowledge page's "Select files from
          {integration}". The template's own label can run to a full sentence
          ("Where this team should keep the watch list, digests and battle
          cards"), which is fine as an explanation and unreadable as a heading:
          it does not scale, it wraps, and it reads as a question the person is
          being interrogated with. It belongs underneath. */}
      <h2 className="object-picker__title">{config.heading(connectorName)}</h2>
      {/* A flat kind has one pick and its wording is the whole question.
          A tree has TWO, and answers whichever one the row's own kind matches:
          tick a folder and you have answered the folder pick, tick a file and
          you have answered the file pick. That routing is invisible, and the
          labels — the entire content of both questions — used to be hidden
          here on the grounds that "the rows speak for themselves".

          They do not. On the Competitive Intelligence template the folder pick
          is "Where this team should save its work" and the file pick is "Your
          positioning or messaging document"; a person who picked a document
          meaning the first was silently recorded as answering the second, hired
          a team with no save destination, and got nine documents scattered
          across their Drive with nothing to say why.

          The LABELS are what fixed that. A kind badge above them said "Folder
          or file" over a line already reading "Where this team should save its
          work", which is the control describing itself to someone looking at
          it. The person has come here to name a place; whether that place is a
          folder or a document is their choice to make, not a fact they need
          announcing back. */}
      {!config.hierarchical ? (
        <p className="object-picker__subtitle">{object.label || config.fallbackTitle}</p>
      ) : (
        <ul className="object-picker__picks">
          {destinationPickLabel && (
            <li className="object-picker__pick">
              {destinationPickLabel}
            </li>
          )}
          {folderPick && (
            <li className="object-picker__pick">
              {folderPick.label}
            </li>
          )}
          {filePick && (
            <li className="object-picker__pick">
              {filePick.label}
            </li>
          )}
        </ul>
      )}

      {config.hierarchical ? (
        // FilePicker owns its own Cancel/Confirm footer, so this branch does
        // not render one. Two sets of actions in one modal is the kind of thing
        // that looks fine in code and obviously broken on screen.
        <FilePicker
          connectorId={connectorId}
          alreadySelectedIds={selected ? [selected.id] : []}
          isBusy={false}
          // A binding holds one folder and one file. The templates are written
          // the same way: "the positioning document you were given ... name it
          // on the card". A second tick of a kind has nowhere to go.
          singlePerKind
          // What the row seeded above is, so reopening and picking again
          // replaces the current answer instead of showing two ticks.
          alreadySelectedKind={object.kind === 'folder' ? 'folder' : 'file'}
          onClose={onClose}
          onSelect={(results: BrowseResult[]) => {
            if (!results.length) {
              onClose()
              return
            }
            // Route each row to the pick its own kind answers. The last of a
            // kind wins: a destination is one place, so checking a second
            // folder replaces the first rather than accumulating.
            // A destination takes whatever was chosen. It is ONE question, so
            // the row's kind cannot select a different one to answer — which is
            // the whole reason it exists.
            const destinationPick = hierarchical.find(o => o.kind === 'destination')
            if (destinationPick) {
              const last = results[results.length - 1]
              if (last) {
                onPick(destinationPick.id, {
                  id: last.id,
                  title: last.title,
                  kind: last.contentType === 'folder' ? 'folder' : 'file',
                })
                onClose()
              }
              return
            }

            const folders = results.filter(r => r.contentType === 'folder')
            const files = results.filter(r => r.contentType !== 'folder')

            const assign = (
              pick: RequirementObject | undefined,
              rows: BrowseResult[],
            ) => {
              const last = rows[rows.length - 1]
              if (pick && last) onPick(pick.id, { id: last.id, title: last.title })
            }

            assign(folderPick, folders)
            assign(filePick, files)

            // Nothing matched a pick this connection asks for — a file checked
            // when only a folder was wanted. Falling through to close would
            // discard the answer silently, so the choice stands and the modal
            // stays for them to correct it.
            const matched = (folderPick && folders.length) || (filePick && files.length)
            if (matched) onClose()
          }}
        />
      ) : (
        <>
          <FlatObjectList
            connectorId={connectorId}
            entityType={config.entityType}
            emptyMessage={config.emptyMessage}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onUnsupported={() => onUnsupported?.(object.id)}
          />
          <div className="object-picker__actions">
            <Button variant="text" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!selected}
              onClick={() => {
                if (selected) {
                  onPick(object.id, selected)
                  onClose()
                }
              }}
            >
              Confirm
            </Button>
          </div>
        </>
      )}
    </ModalOverlay>
  )
}

interface FlatObjectListProps {
  connectorId: string
  entityType?: string
  emptyMessage: string
  selectedId: string | null
  onSelect: (picked: PickedObject) => void
  onUnsupported: () => void
}

/** A flat list for kinds with no hierarchy. A channel has nothing to expand
 *  into, so FilePicker's folder machinery would only be in the way. */
function FlatObjectList({ connectorId, entityType, emptyMessage, selectedId, onSelect, onUnsupported }: FlatObjectListProps) {
  const [query, setQuery] = useState('')
  const { data, isPending, isError } = useBrowseConnector(connectorId, query, undefined, undefined, entityType)
  // A to Z, same as the tree. Slack returns channels in creation order, which
  // is no order at all to someone looking for one by name.
  const rows = [...(data?.pages.flatMap(p => p.results) ?? [])].sort((a, b) =>
    (a.title ?? '').localeCompare(b.title ?? '', undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )
  // The backend now separates "this connector cannot list that" from "you have
  // none of it". Both arrive as an empty array, so without this flag the picker
  // would keep telling a person their workspace is empty when the gap is ours.
  const unsupported = data?.pages.some(p => p.unsupported) ?? false

  // Tell the step, so a pick nobody can answer stops holding the hire. The
  // message below says they may continue; this is what makes that true.
  useEffect(() => {
    if (unsupported) onUnsupported()
  }, [unsupported, onUnsupported])

  return (
    <div className="object-picker__list">
      <input
        type="text"
        className="object-picker__search"
        placeholder="Search"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {isPending && <p className="object-picker__state">Loading…</p>}
      {/* Distinguished from empty on purpose: "none found" and "we could not
          ask" send a person to different places. */}
      {isError && <p className="object-picker__state">Could not load from this connection.</p>}
      {/* Three different empties, three different answers. Saying "none found"
          for a gap on our side would send a person hunting through a workspace
          that is not the problem. */}
      {!isPending && !isError && rows.length === 0 && unsupported && (
        <p className="object-picker__state">
          Liftoff cannot list these from this connection yet. You can continue
          without picking one, or choose a different connection.
        </p>
      )}
      {!isPending && !isError && rows.length === 0 && !unsupported && (
        <p className="object-picker__state">{emptyMessage}</p>
      )}
      {rows.map(row => (
        <button
          type="button"
          key={row.id}
          className={`object-picker__row${selectedId === row.id ? ' object-picker__row--selected' : ''}`}
          onClick={() => onSelect({ id: row.id, title: row.title })}
        >
          <span className="object-picker__row-title">{row.title}</span>
        </button>
      ))}
    </div>
  )
}
