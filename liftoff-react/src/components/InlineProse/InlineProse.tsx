import { useLayoutEffect, useRef, useState } from 'react'
import { parseInline, type InlineSegment, type ProseBlock } from '../../utils/inlineProse'
import EditHint from './EditHint'
import {
  CHIP_REMOVE_CLASS,
  buildPart,
  lineClassName,
  placeCaretAtEnd,
  placeCaretAtOffset,
  serializePart,
  visibleOffsetFromPoint,
} from './editorDom'
import './InlineProse.css'

/** Template guidance that can be rewritten in place.
 *
 *  It should not feel like an editor. At rest this is prose; hovering a line
 *  dots its underline; clicking puts a caret where you clicked. There is no
 *  toolbar, no frame, and no mode to leave — an edit is applied by looking away
 *  from it, the same as closing a fold.
 *
 *  The whole part is ONE editable field, not one per line, and that is the
 *  decision everything else follows from. A browser selection cannot cross a
 *  contenteditable boundary, so per-line editors meant you could not drag
 *  across three bullets to delete them, could not paste a block of text over
 *  several steps, and could not undo across a line break. Selecting, deleting,
 *  pasting and undo all work here because the browser is doing them, on one
 *  field, as it would anywhere else.
 *
 *  Placeholders are why this is not simply a textarea. A line reading "post to
 *  your finance channel" is stored as `{{connector:opt-team-chat}}`, resolved
 *  later against the connection the person actually picks. Editing the resolved
 *  words and saving them back would bake in the generic phrase and quietly cost
 *  them their real channel, so a placeholder is a chip that can be moved or
 *  deleted whole but never typed into, and is written back out as its token.
 */

interface InlineProseProps {
  blocks: ProseBlock[]
  /** Renders one `connector:x` / `pick:x` token, or a declared input, as the
   *  phrase it stands for. */
  resolveToken: (token: string) => string
  /** Whether a bare `{{id}}` is one of this template's declared inputs. An
   *  input is a chip for the same reason a destination is: editing the words it
   *  resolved to would bake the phrase into the stored prose and lose what the
   *  person types on the connectors step. */
  isInputToken?: (id: string) => boolean
  /** The part was rewritten. Lines carry source text, tokens intact. */
  onChange: (blocks: ProseBlock[]) => void
}

export default function InlineProse({ blocks, resolveToken, isInputToken, onChange }: InlineProseProps) {
  /** Where the caret should land when the editor opens, in visible characters
   *  from the start of the part. Null means this part is not being edited. */
  const [openAt, setOpenAt] = useState<number | null>(null)

  if (openAt !== null) {
    return (
      <>
        <PartEditor
          blocks={blocks}
          resolveToken={resolveToken}
          isInputToken={isInputToken}
          caretAt={openAt}
          onClose={(next) => {
            setOpenAt(null)
            if (next) onChange(next)
          }}
        />
        <EditHint />
      </>
    )
  }

  return (
    <div
      className="inline-prose"
      role="button"
      tabIndex={0}
      aria-label="Rewrite this section"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(`.${CHIP_REMOVE_CLASS}`)) return
        // Read and edit render differently — chips grow a remove control, words
        // lose their spans — so a click cannot be carried over as a node and an
        // offset. Counted in visible characters, which both renderings agree
        // on, the caret lands on the word that was actually clicked.
        const offset = visibleOffsetFromPoint(e.currentTarget, e.clientX, e.clientY)
        // The browser must not also place focus for this gesture. Its target
        // is the resting node, which this click is about to replace, so its
        // focus lands nowhere and the editor that just mounted is blurred
        // before anyone can type into it — the click appears to do nothing at
        // all. The caret is placed deliberately once the editor mounts.
        e.preventDefault()
        setOpenAt(offset ?? 0)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        setOpenAt(0)
      }}
    >
      {blocks.map((block, index) => (
        <div
          key={index}
          className={lineClass(block)}
          data-kind={block.kind}
        >
          {block.text
            ? parseInline(block.text, isInputToken).map((segment, i) => (
              <ReadSegment key={i} segment={segment} resolveToken={resolveToken} />
            ))
            : null}
        </div>
      ))}
    </div>
  )
}

/** The resting classes: the shared geometry ones, plus the placeholder marker,
 *  which paints text but no height and so cannot shift anything. */
function lineClass(block: ProseBlock): string {
  const shared = lineClassName(block.kind)
  return block.text ? shared : `${shared} inline-prose__line--empty`
}

/** One piece of a line at rest. */
function ReadSegment({
  segment,
  resolveToken,
}: {
  segment: InlineSegment
  resolveToken: (token: string) => string
}) {
  if (segment.kind === 'token') {
    const label = resolveToken(segment.token)
    if (!label) return null
    const chip = <span className="inline-prose__chip">{label}</span>
    return segment.bold ? <strong className="inline-prose__bold">{chip}</strong> : chip
  }
  if (segment.kind === 'code') {
    return <code className="inline-prose__code">{segment.text}</code>
  }

  return segment.bold
    ? <strong className="inline-prose__bold">{segment.text}</strong>
    : <>{segment.text}</>
}

interface PartEditorProps {
  blocks: ProseBlock[]
  resolveToken: (token: string) => string
  isInputToken?: (id: string) => boolean
  caretAt: number
  /** `null` means nothing changed, or the edit was abandoned. */
  onClose: (blocks: ProseBlock[] | null) => void
}

/** The part, with a caret in it.
 *
 *  Deliberately uncontrolled: React populates the node once on mount and does
 *  not touch it again. A contentEditable re-rendered from state on every
 *  keystroke fights the browser for the caret and loses, and the chips have to
 *  survive being typed around, which means the DOM is the source of truth until
 *  the edit is applied.
 */
function PartEditor({ blocks, resolveToken, isInputToken, caretAt, onClose }: PartEditorProps) {
  const ref = useRef<HTMLDivElement>(null)
  /** Set once the edit has been resolved, so the blur that follows Escape
   *  cannot apply it against a node React is already unmounting. */
  const settled = useRef(false)
  // Layout, not passive: a passive effect runs after paint, so the editor would
  // mount empty and unfocused for a frame while the browser is still resolving
  // the gesture that opened it. Content and caret land before anything is drawn.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.replaceChildren(...buildPart(blocks, resolveToken, isInputToken))
    if (caretAt > 0) placeCaretAtOffset(el, caretAt)
    else placeCaretAtEnd(el)
    // Mount only. Re-running on a `blocks` change would rebuild the node under
    // the caret mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    const el = ref.current
    if (!el) return onClose(null)

    const lines = serializePart(el)
    // A part emptied completely keeps one blank line, so there is still
    // something to click on to write it back.
    const next: ProseBlock[] = lines.length
      ? lines.map((line) => {
        // A line whose text is unchanged keeps its original entry, so
        // rewriting one step does not mark the other twenty as edited.
        const before = blocks.find((b) => b.text === line.text)
        return before ?? { kind: line.kind as ProseBlock['kind'], text: line.text, edited: true }
      })
      : [{ kind: blocks[0]?.kind ?? 'p', text: '', edited: true }]

    const unchanged =
      next.length === blocks.length && next.every((b, i) => b.text === blocks[i].text)
    onClose(unchanged ? null : next)
  }

  return (
    <div
      ref={ref}
      className="inline-prose inline-prose--editing"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Rewrite this section"
      tabIndex={0}
      spellCheck
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        settled.current = true
        onClose(null)
      }}
      onClick={(e) => {
        const remove = (e.target as HTMLElement).closest(`.${CHIP_REMOVE_CLASS}`)
        if (!remove) return
        e.preventDefault()
        remove.closest('.inline-prose__chip')?.remove()
      }}
      // Pasted text arrives as words, not as whatever markup it came wrapped
      // in. A styled block from a document would otherwise bring spans, colours
      // and fonts into a field that is read back as source text.
      onPaste={(e) => {
        e.preventDefault()
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
      }}
      onBlur={() => {
        if (settled.current) return
        settled.current = true
        commit()
      }}
    />
  )
}
