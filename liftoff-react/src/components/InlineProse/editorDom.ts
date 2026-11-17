// The DOM half of inline editing: building an editable line, and reading one
// back as source text.
//
// Separate from the component so both halves can be tested directly and so the
// component file exports nothing but a component (react-refresh). Getting the
// read-back wrong is silent — a template's `{{pick:...}}` would be replaced by
// the words it was displaying, and the hire would quietly target a generic
// phrase instead of the channel the person picked — so it is worth its own
// module and its own tests.

import { inlineToText, parseInline, type InlineSegment } from '../../utils/inlineProse'

export const CHIP_CLASS = 'inline-prose__chip'
export const CHIP_REMOVE_CLASS = 'inline-prose__chip-remove'

/** Build the editable content for one line.
 *
 *  Placeholders become `contenteditable=false` chips so the caret steps over
 *  them as a unit and typing can never land inside one. */
export function buildNodes(
  text: string,
  resolveToken: (token: string) => string,
  isInputToken?: (id: string) => boolean,
): Node[] {
  const nodes: Node[] = []

  for (const segment of parseInline(text, isInputToken)) {
    if (segment.kind === 'token') {
      const label = resolveToken(segment.token)
      // A token that resolves to nothing renders as nothing, which is what
      // `proseForDisplay` already does with an unbound optional connector.
      if (!label) continue
      const chip = document.createElement('span')
      chip.className = CHIP_CLASS
      // setAttribute rather than the IDL property: the property does not
      // reflect to the attribute in jsdom, so the guard that stops the caret
      // landing inside a chip would be untestable and could regress unseen.
      chip.setAttribute('contenteditable', 'false')
      chip.dataset.token = segment.token
      chip.append(label)
      const remove = document.createElement('span')
      remove.className = CHIP_REMOVE_CLASS
      remove.title = 'Remove'
      remove.append('×')
      chip.append(remove)
      nodes.push(segment.bold ? bolded(chip) : chip)
      continue
    }

    if (segment.kind === 'code') {
      const code = document.createElement('code')
      code.className = 'inline-prose__code'
      code.append(segment.text)
      nodes.push(code)
      continue
    }

    const text = document.createTextNode(segment.text)
    nodes.push(segment.bold ? bolded(text) : text)
  }

  return nodes

  /** One node inside a <strong>. A bold run carrying a placeholder produces
   *  several of these and the browser paints them as one run. */
  function bolded(child: Node): HTMLElement {
    const strong = document.createElement('strong')
    strong.className = 'inline-prose__bold'
    strong.append(child)
    return strong
  }
}

/** Read an edited line back as source text.
 *
 *  This is the half of the round trip that keeps a template's placeholders
 *  alive: a chip becomes its `{{token}}` again rather than the words it was
 *  showing. Step numbers need no handling: they are CSS counters, so they were
 *  never in the DOM to be read back. */
export function serializeEditor(root: HTMLElement): string {
  const segments: InlineSegment[] = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      segments.push({ kind: 'text', text: node.nodeValue ?? '' })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement

    if (el.classList.contains(CHIP_CLASS)) {
      const token = el.dataset.token
      if (token) segments.push({ kind: 'token', token })
      return
    }
    if (el.tagName === 'BR') {
      segments.push({ kind: 'text', text: ' ' })
      return
    }
    if (el.tagName === 'STRONG' || el.tagName === 'B') {
      // Recurse rather than read textContent: a bold run can hold a chip, and
      // flattening one writes its resolved words into the stored prose in
      // place of the token, which is how somebody would lose the channel they
      // picked without anything reporting it.
      const from = segments.length
      el.childNodes.forEach(walk)
      for (let i = from; i < segments.length; i++) {
        const seg = segments[i]
        if (seg.kind !== 'code') seg.bold = true
      }
      return
    }
    if (el.tagName === 'CODE') {
      segments.push({ kind: 'code', text: el.textContent ?? '' })
      return
    }
    el.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
  // A contentEditable leaves non-breaking spaces and stray newlines behind;
  // none of them are meaningful in a single-line block.
  return inlineToText(segments).replace(/\s+/g, ' ').trim()
}

export const LINE_CLASS = 'inline-prose__line'

/** The classes a line carries, for BOTH renderings.
 *
 *  Shared rather than restated on each side because every class here decides
 *  geometry: a lead-in's larger top gap lives on `--lead`, and stamping it in
 *  one rendering but not the other made the whole section reflow the instant
 *  somebody clicked into it. The two must be indistinguishable. */
export function lineClassName(kind: string): string {
  return kind === 'lead' ? `${LINE_CLASS} inline-prose__line--lead` : LINE_CLASS
}

/** Build a whole part as one editable body, one element per line.
 *
 *  One editor per PART rather than per line, and that is the whole point:
 *  a selection cannot cross a contenteditable boundary, so per-line editors
 *  meant no dragging across three bullets to delete them and no pasting a
 *  block of text over several steps. Everything the browser already does well
 *  — selection, delete, paste, undo — works here because it is all one field.
 *
 *  Line numbers are NOT in the DOM; they are CSS counters (see the stylesheet).
 *  A number that existed as text could be selected, typed over and deleted,
 *  and the list would renumber around the hole. */
export function buildPart(
  blocks: { kind: string; text: string }[],
  resolveToken: (token: string) => string,
  isInputToken?: (id: string) => boolean,
): Node[] {
  return blocks.map((block) => {
    const line = document.createElement('div')
    line.className = lineClassName(block.kind)
    line.dataset.kind = block.kind
    const nodes = buildNodes(block.text, resolveToken, isInputToken)
    // An empty line still needs a box to put a caret in; a <br> is what the
    // browser itself leaves behind when you empty one.
    if (nodes.length === 0) line.append(document.createElement('br'))
    else line.append(...nodes)
    return line
  })
}

/** Read an edited part back as lines of source text.
 *
 *  Browsers differ on what they leave behind: Enter usually produces a sibling
 *  <div>, but a part emptied to nothing can collapse to bare text nodes, and a
 *  pasted block can arrive as anything. So this takes the element children as
 *  the lines when there are any, and treats the whole body as one line when
 *  there are not, rather than trusting the shape. */
export function serializePart(root: HTMLElement): { kind: string; text: string }[] {
  const children = [...root.children].filter((el) => el.tagName !== 'BR')
  if (children.length === 0) {
    const text = serializeEditor(root)
    return text ? [{ kind: 'p', text }] : []
  }

  const lines: { kind: string; text: string }[] = []
  let lastKind = 'p'
  for (const child of children) {
    const el = child as HTMLElement
    // A line the browser created by splitting another usually inherits its
    // data-kind; when it does not, a new line continues whatever ran above it,
    // which is what pressing Enter in a list means.
    const kind = el.dataset.kind || lastKind
    lastKind = kind
    const text = serializeEditor(el)
    if (text) lines.push({ kind, text })
  }
  return lines
}

/** Put the caret at the end of a freshly opened line. */
export function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  apply(range, el)
}

/** Put the caret `offset` visible characters into a line.
 *
 *  Used after two lines are merged, so the caret lands where the join happened
 *  rather than at the end of the text that just arrived. The `×` inside a chip
 *  is skipped: it is a control, not a character anybody counted when they
 *  looked at the sentence. */
export function placeCaretAtOffset(el: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement?.closest(`.${CHIP_REMOVE_CLASS}`)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT),
  })

  let remaining = offset
  let node = walker.nextNode()
  while (node) {
    const length = node.nodeValue?.length ?? 0
    if (remaining <= length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      apply(range, el)
      return
    }
    remaining -= length
    node = walker.nextNode()
  }
  placeCaretAtEnd(el)
}

/** How many visible characters into `el` a click at these coordinates lands.
 *
 *  Read-mode and edit-mode DOM differ (chips grow a `×`, words lose their
 *  spans), so a click position cannot be carried across as a node and offset.
 *  Counted in visible characters instead, which both renderings agree on. */
export function visibleOffsetFromPoint(el: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }

  let point: Range | null = null
  if (doc.caretRangeFromPoint) {
    point = doc.caretRangeFromPoint(x, y)
  } else if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y)
    if (position) {
      point = document.createRange()
      point.setStart(position.offsetNode, position.offset)
    }
  }
  if (!point || !el.contains(point.startContainer)) return null

  const before = document.createRange()
  before.selectNodeContents(el)
  before.setEnd(point.startContainer, point.startOffset)
  return before.toString().length
}

function apply(range: Range, el: HTMLElement): void {
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  el.focus()
}
