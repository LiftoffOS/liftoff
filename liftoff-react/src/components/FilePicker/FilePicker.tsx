import { useState, useRef, useEffect, useCallback } from 'react'
import Button from '../Button'
import TextInput from '../TextInput/TextInput'
import { useBrowseConnector } from '../../hooks/useKnowledge'
import type { BrowseResult } from '../../services/knowledge'
import { EXTRACTABLE_MIME_TYPES } from '../../config/knowledgeConnectors'
import ChevronRightIcon from '../../assets/icons/chevron-right.svg?react'
import { track } from '../../lib/analytics'
// Owns its stylesheet, so it arrives styled wherever it is rendered. It used to
// be re-exported from components/index.ts, where a CSS side-effect leaked into
// the entry chunk (see scripts/verify/css-closure.mjs) and the styles had to be
// imported by each route page by hand instead. It is out of that barrel now.
import './FilePicker.css'
import { useAutoFocus } from '../../hooks/useAutoFocus'

/** A to Z, the way a person scans a list they are hunting through.
 *
 *  Every connector returned its own order and none of them returned this one:
 *  Google Docs sorted by modified time, Drive used whatever Drive felt like,
 *  Dropbox and Box used theirs. So the same drive looked different depending on
 *  which connector reached it, and finding a known name meant reading every row.
 *
 *  Sorted here rather than per connector, because doing it in twenty clients is
 *  twenty chances to do it differently, and some vendors offer no ordering at
 *  all. `numeric` so "Report 2" precedes "Report 10", and `sensitivity: base`
 *  so case and accents do not split neighbours apart.
 *
 *  Only the rows fetched so far can be ordered. A paginated listing therefore
 *  sorts within what has loaded, which is what the caller is looking at. */
function byName(rows: BrowseResult[]): BrowseResult[] {
  return [...rows].sort((a, b) =>
    (a.title ?? '').localeCompare(b.title ?? '', undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )
}

// ─── Folder Row ───────────────────────────────────────────────────────────────

interface FolderRowProps {
  folder: BrowseResult
  connectorId: string
  depth: number
  /** Checked rows, keyed by external id. See CheckedRows below — presence of
   *  the key is what "checked" means, and the value may be null for a row that
   *  the caller already holds but the user has not seen in the tree. */
  selected: CheckedRows
  onToggleFile: (result: BrowseResult) => void
  trackContext: string
}

function FolderRow({ folder, connectorId, depth, selected, onToggleFile, trackContext }: FolderRowProps) {
  const [expanded, setExpanded] = useState(false)
  const handleToggleExpand = () => {
    const next = !expanded
    if (next) track('knowledge_file_picker_folder_expanded', { folder_id: folder.id, context: trackContext })
    setExpanded(next)
  }

  const { data, isPending } = useBrowseConnector(
    expanded ? connectorId : null,
    '',
    folder.id,
    EXTRACTABLE_MIME_TYPES,
  )

  const children = data?.pages.flatMap((p) => p.results) ?? []
  const childFolders = byName(children.filter((r) => r.contentType === 'folder'))
  const childFiles = byName(children.filter((r) => r.contentType !== 'folder'))
  const indent = depth * 16

  return (
    <div className="file-picker__tree-node">
      <div
        className={`file-picker__folder${expanded ? ' file-picker__folder--open' : ''}`}
        style={{ paddingLeft: 12 + indent }}
      >
        <label className="file-picker__folder-check">
          <span className="sr-only">Select {folder.title}</span>
          <input
            type="checkbox"
            checked={selected.has(folder.id)}
            onChange={() => onToggleFile(folder)}
          />
          <span className="checkbox__checkmark" />
        </label>
        <button className="file-picker__folder-btn" onClick={handleToggleExpand}>
          <span className="file-picker__folder-name">{folder.title}</span>
          <ChevronRightIcon
            className={`file-picker__folder-chevron${expanded ? ' file-picker__folder-chevron--open' : ''}`}
          />
        </button>
      </div>
      {expanded && (
        <div className="file-picker__tree-children">
          {isPending ? (
            <div className="file-picker__folder-loading" style={{ paddingLeft: 12 + indent + 16 }}>
              <div className="loading-spinner loading-spinner--sm" role="status" aria-label="Loading folder" />
            </div>
          ) : (
            <>
              {childFolders.map((f) => (
                <FolderRow
                  key={f.id}
                  folder={f}
                  connectorId={connectorId}
                  depth={depth + 1}
                  selected={selected}
                  onToggleFile={onToggleFile}
                  trackContext={trackContext}
                />
              ))}
              {childFiles.map((f) => (
                <label
                  key={f.id}
                  className="file-picker__item"
                  style={{ paddingLeft: 12 + indent + 16 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => onToggleFile(f)}
                  />
                  <span className="checkbox__checkmark" />
                  <span className="file-picker__item-title">{f.title}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── File Picker ──────────────────────────────────────────────────────────────

interface FilePickerProps {
  connectorId: string
  /** Fires on confirm with the browse rows the user checked, and the ids from
   *  `alreadySelectedIds` they unchecked. Callers map the rows into their own
   *  domain shape (knowledge items on the knowledge page, team attachments in
   *  the import popover) and drop what came back as removed. */
  onSelect: (results: BrowseResult[], removedIds: string[]) => void
  onClose: () => void
  isBusy: boolean
  /** External ids the caller already holds. They render checked, which is what
   *  makes this a management surface rather than an add-only one: unchecking a
   *  row and confirming reports it back through `onSelect`'s second argument.
   *  Without it, the modal opens blank over a collection that is not empty and
   *  there is no way to take anything out. */
  alreadySelectedIds?: readonly string[]
  /** Verb on the confirm button ("Add 2 items" / "Attach 2 items"). */
  actionVerb?: string
  /** Added as a `context` property on the picker's track events. */
  trackContext?: string
  /** At most one folder and one file may be ticked at a time.
   *
   *  For callers that store a single value per kind. The knowledge page imports
   *  as many files as you like and leaves this off; a connector binding holds
   *  one destination and one source, so a second tick has nowhere to go. */
  singlePerKind?: boolean
  /** What kind the `alreadySelectedIds` rows are.
   *
   *  Read only under `singlePerKind`. A row that arrived already ticked has no
   *  browse result behind it yet, so its kind is otherwise unknown and a new
   *  tick cannot tell whether it replaces that row or sits beside it. */
  alreadySelectedKind?: 'folder' | 'file'
}

// A checked row is either one the user ticked in this session (we hold its
// BrowseResult, ready to hand back) or one that arrived via
// `alreadySelectedIds` and has not been touched (null — the caller already has
// it, so there is nothing to send). Presence of the key is what "checked"
// means; the value only decides whether it is worth re-sending.
type CheckedRows = Map<string, BrowseResult | null>

function seedChecked(ids: readonly string[]): CheckedRows {
  return new Map(ids.map((id) => [id, null]))
}

export default function FilePicker({
  connectorId,
  onSelect,
  onClose,
  isBusy,
  alreadySelectedIds = [],
  actionVerb = 'Add',
  trackContext = 'knowledge',
  singlePerKind = false,
  alreadySelectedKind,
}: FilePickerProps) {
  const searchRef = useAutoFocus<HTMLInputElement>()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState<CheckedRows>(() => seedChecked(alreadySelectedIds))
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Fire knowledge_connector_browsed once per unique connectorId+query pair
  // when the first non-empty page lands.
  const browsedKeyRef = useRef<string | null>(null)

  // Depend on the ids themselves, not the array identity — a parent that maps
  // over its items builds a fresh array every render, which would reset the
  // user's ticks on each one.
  const alreadySelectedKey = alreadySelectedIds.join(',')

  useEffect(() => {
    if (!debouncedQuery) return
    track('knowledge_file_picker_searched', { query_length: debouncedQuery.length, context: trackContext })
  }, [debouncedQuery, trackContext])

  // Start over when the picker is pointed at a different connector or a
  // different set of already-picked ids. The baseline starts at the CURRENT key
  // rather than undefined, because the initial state above is already seeded
  // from it: an undefined baseline would reset the picker on its first render.
  const resetKey = `${connectorId}|${alreadySelectedKey}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    setSelected(seedChecked(alreadySelectedKey ? alreadySelectedKey.split(',') : []))
    setQuery('')
    setDebouncedQuery('')
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const { data, isPending, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useBrowseConnector(connectorId, debouncedQuery, undefined, EXTRACTABLE_MIME_TYPES)

  const allResults = byName(data?.pages.flatMap((p) => p.results) ?? [])

  useEffect(() => {
    if (allResults.length === 0) return
    const key = `${connectorId}|${debouncedQuery}`
    if (browsedKeyRef.current === key) return
    browsedKeyRef.current = key
    track('knowledge_connector_browsed', {
      connector_id: connectorId,
      query_length: debouncedQuery.length,
      context: trackContext,
    })
  }, [allResults.length, connectorId, debouncedQuery, trackContext])
  const rootFolders = allResults.filter((r) => r.contentType === 'folder')
  const rootFiles = allResults.filter((r) => r.contentType !== 'folder')

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el || !hasNextPage || isFetchingNextPage) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const toggleFile = (result: BrowseResult) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(result.id)) {
        next.delete(result.id)
      } else {
        // A caller that stores one value per kind cannot keep a second, so
        // ticking one here unticks the other of its kind rather than letting
        // the confirm quietly discard it. A row that arrived already ticked
        // carries no result of its own, so its kind comes from the caller.
        if (singlePerKind) {
          const isFolder = result.contentType === 'folder'
          for (const [id, row] of next) {
            const rowKindKnown = row !== null || alreadySelectedKind !== undefined
            const rowIsFolder = row
              ? row.contentType === 'folder'
              : alreadySelectedKind === 'folder'
            if (rowKindKnown && rowIsFolder === isFolder) next.delete(id)
          }
        }
        next.set(result.id, result)
      }
      track('knowledge_file_picker_file_toggled', { selected_count: next.size, context: trackContext })
      return next
    })
  }

  // Rows the caller does not have yet (or that were unticked and re-ticked).
  // An untouched already-selected row stays null and is left out: the caller
  // holds it already, so re-sending it would be a no-op write.
  const toAdd = Array.from(selected.values()).filter((r): r is BrowseResult => r !== null)
  const toRemove = alreadySelectedIds.filter((id) => !selected.has(id))

  const handleConfirm = () => {
    track('knowledge_file_picker_added', {
      count: toAdd.length,
      removed_count: toRemove.length,
      context: trackContext,
    })
    onSelect(toAdd, toRemove)
  }

  // "Add 2 items" reads wrong when the confirm only takes things out, and
  // worse when it does both.
  const confirmLabel = (() => {
    if (isBusy) return `${actionVerb}ing…`
    if (toRemove.length > 0 && toAdd.length > 0) return 'Save changes'
    if (toRemove.length > 0) {
      return `Remove ${toRemove.length} item${toRemove.length !== 1 ? 's' : ''}`
    }
    return `${actionVerb} ${toAdd.length > 0 ? `${toAdd.length} ` : ''}item${toAdd.length !== 1 ? 's' : ''}`
  })()

  return (
    <div className="file-picker">
      <div className="file-picker__search">
        <TextInput
          variant="search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          ref={searchRef}
        />
      </div>

      {error ? (
        <div className="file-picker__error">
          Unable to load files. Check that this connector is still connected.
        </div>
      ) : isPending ? (
        <div className="file-picker__loading">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="file-picker__skeleton skeleton-pulse" />
          ))}
        </div>
      ) : allResults.length === 0 ? (
        <div className="file-picker__empty">
          {debouncedQuery ? `No files matching "${debouncedQuery}"` : 'No files found'}
        </div>
      ) : (
        <div className="file-picker__list" ref={listRef} onScroll={handleScroll}>
          {rootFolders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              connectorId={connectorId}
              depth={0}
              selected={selected}
              onToggleFile={toggleFile}
              trackContext={trackContext}
            />
          ))}
          {rootFiles.map((result) => (
            <label key={result.id} className="file-picker__item">
              <input
                type="checkbox"
                checked={selected.has(result.id)}
                onChange={() => toggleFile(result)}
              />
              <span className="checkbox__checkmark" />
              <span className="file-picker__item-title">{result.title}</span>
            </label>
          ))}
          {isFetchingNextPage && (
            <div className="file-picker__load-more">
              <div className="loading-spinner loading-spinner--sm" role="status" aria-label="Loading more results" />
            </div>
          )}
        </div>
      )}

      <div className="file-picker__footer">
        <Button
          variant="outline"
          onClick={() => {
            track('knowledge_file_picker_canceled', { context: trackContext })
            onClose()
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          disabled={(toAdd.length === 0 && toRemove.length === 0) || isBusy}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
