import { useEffect, useRef, useState } from 'react'
import EditHint from './EditHint'
import { placeCaretAtEnd } from './editorDom'
import './InlineProse.css'

/** A single line of plain text, rewritable in place.
 *
 *  The same interaction as `InlineProse` — hover dots the underline, click puts
 *  a caret in it, Escape reverts, looking away applies — for a value that is
 *  one line with no markdown and no placeholders in it. The team's name is the
 *  only such value on the detail step, and it would be strange to let someone
 *  rewrite every line of what a team does but not what it is called.
 *
 *  Enter applies here rather than starting a new line: there is no list to
 *  extend, and a heading that grew a second line would not be a heading.
 */
interface InlineTextProps {
  value: string
  onChange: (value: string) => void
  /** Longer than this is refused rather than truncated, so nobody loses the
   *  end of a name they typed without being told. */
  maxLength: number
  /** Rendered as the element itself, so the name keeps its heading semantics
   *  and its place in the document outline while being editable. */
  as: 'h1' | 'h2'
  className?: string
  editLabel: string
}

export default function InlineText({
  value,
  onChange,
  maxLength,
  as: Tag,
  className = '',
  editLabel,
}: InlineTextProps) {
  const ref = useRef<HTMLHeadingElement>(null)
  const settled = useRef(false)
  /** Drives the same hint the prose lines show. Held in state rather than left
   *  to a :focus rule because the hint is a sibling, and CSS has no way to
   *  reach one from a focused element that comes before it. */
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // While typing, the DOM is the source of truth. Repainting here would
    // rebuild the node under the caret on every keystroke, which is the same
    // reason the prose editor is left alone once it is open.
    if (editing) return
    if (el.textContent !== value) el.textContent = value
  }, [value, editing])

  const commit = () => {
    const el = ref.current
    if (!el) return
    const next = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    // An empty name is not a rename, it is a mistake; put the old one back
    // rather than hiring something with no name.
    if (!next.length || next.length > maxLength) {
      el.textContent = value
      return
    }
    if (next !== value) onChange(next)
  }

  return (
    <>
      <Tag
        ref={ref}
        // The editing marker is what the page-wide hover suppression keys off
        // (see InlineProse.css), so every affordance goes quiet while the name
        // is being typed into, not just this one.
        className={`inline-text ${editing ? 'inline-text--editing ' : ''}${className}`.trim()}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="false"
        aria-label={editLabel}
        tabIndex={0}
        spellCheck
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            settled.current = true
            commit()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            settled.current = true
            if (ref.current) ref.current.textContent = value
            ref.current?.blur()
          }
        }}
        onFocus={() => {
          settled.current = false
          setEditing(true)
          if (ref.current) placeCaretAtEnd(ref.current)
        }}
        onBlur={() => {
          setEditing(false)
          if (settled.current) return
          settled.current = true
          commit()
        }}
        // Pasting a styled heading from elsewhere should bring its words, not its
        // markup — this element's content is read back as plain text.
        onPaste={(e) => {
          e.preventDefault()
          const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ')
          document.execCommand('insertText', false, text)
        }}
      />

      {editing && <EditHint />}
    </>
  )
}
