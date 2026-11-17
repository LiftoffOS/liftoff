// The half of inline editing that fails silently.
//
// A person edits a line reading "post to your finance channel" — which is
// stored as `{{connector:opt-team-chat}}` and resolved against the connection
// they pick two steps later. If the edit writes back the words instead of the
// token, nothing errors: the hire just quietly targets a generic phrase rather
// than their channel. So the round trip is tested directly, not inferred.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InlineProse from './InlineProse'
import { serializeEditor } from './editorDom'
import type { ProseBlock } from '../../utils/inlineProse'

const resolveToken = (token: string) =>
  token === 'connector:opt-team-chat' ? 'post to your finance channel'
  : token === 'pick:alert-channel' ? 'your finance channel'
  : ''

const BLOCKS: ProseBlock[] = [
  { kind: 'lead', text: '**Whenever an invoice arrives:**' },
  { kind: 'ol', text: 'Extract the vendor name and total amount' },
  { kind: 'ol', text: 'If no PO match: flag it and {{connector:opt-team-chat}} an alert' },
]

function setup(overrides: Partial<React.ComponentProps<typeof InlineProse>> = {}) {
  const props = {
    blocks: BLOCKS,
    resolveToken,
    onChange: vi.fn(),
    ...overrides,
  }
  const view = render(<InlineProse {...props} />)
  return { ...view, props }
}

/** Open the part for editing. jsdom has no layout, so caretRangeFromPoint
 *  resolves nothing and the caret falls back to the end — which is what a
 *  click with no resolvable position should do. */
function openPart(container: HTMLElement) {
  fireEvent.mouseDown(screen.getByLabelText('Rewrite this section'))
  return container.querySelector('.inline-prose--editing') as HTMLElement
}

function changed(props: { onChange: unknown }) {
  return vi.mocked(props.onChange as (blocks: ProseBlock[]) => void).mock.calls[0][0]
}

describe('reading', () => {
  it('shows a placeholder as the phrase it stands for, never as braces', () => {
    setup()
    expect(screen.getByText('post to your finance channel')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('{{')
  })

  it('numbers steps with counters rather than text', () => {
    const { container } = setup()
    // Nothing in the DOM carries the number, so it cannot be selected, typed
    // over or deleted, and it renumbers on its own when a step is added.
    expect(container.textContent).not.toContain('1.')
    expect(container.querySelectorAll('[data-kind="ol"]')).toHaveLength(2)
  })

  it('offers no way to delete a chip while the part is only being read', () => {
    const { container } = setup()
    expect(container.querySelector('.inline-prose--editing')).toBeNull()
    expect(container.querySelector('.inline-prose__chip-remove')).toBeNull()
  })

  it('leaves a rewritten line looking exactly like an untouched one', () => {
    // Someone reading this page sees sentences, not a template with resolved
    // placeholders. Marking a line they changed would be the page reacting to
    // something they cannot perceive, which reads as a warning about a mistake
    // rather than as a note about provenance. The text is theirs to shape.
    const { container } = setup({
      blocks: [
        { kind: 'ol', text: 'Untouched line' },
        { kind: 'ol', text: 'My own words', edited: true },
      ],
    })
    const [plain, rewritten] = [...container.querySelectorAll('.inline-prose__line')]
    expect(rewritten.className).toBe(plain.className)
  })
})

describe('opening the part', () => {
  it('replaces the whole part with one editable field, not one per line', () => {
    // The reason this is one field: a browser selection cannot cross a
    // contenteditable boundary, so per-line editors made it impossible to drag
    // across several bullets and delete them, or paste over them.
    const { container } = setup()
    const editor = openPart(container)
    expect(editor).not.toBeNull()
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1)
    expect(editor.querySelectorAll('.inline-prose__line')).toHaveLength(BLOCKS.length)
  })

  it('keeps every line under one editing host so a selection can span them', () => {
    const { container } = setup()
    const editor = openPart(container)
    const lines = editor.querySelectorAll('.inline-prose__line')
    expect(lines[0].closest('[contenteditable="true"]'))
      .toBe(lines[lines.length - 1].closest('[contenteditable="true"]'))
  })

  it('gives every line the same classes it had at rest', () => {
    // Every class on a line decides geometry. `buildPart` was stamping only the
    // base class, so a lead-in lost its larger top gap and the section reflowed
    // the instant anybody clicked into it.
    const { container } = setup()
    const resting = [...container.querySelectorAll('.inline-prose__line')]
      .map((el) => el.className.replace(' inline-prose__line--empty', ''))
    const editing = [...openPart(container).querySelectorAll('.inline-prose__line')]
      .map((el) => el.className)
    expect(editing).toEqual(resting)
  })

  it('stops the browser placing focus for the opening gesture', () => {
    // The browser's target is the resting node, which the click is about to
    // replace, so its focus lands nowhere and blurs the editor that just
    // mounted — the click appears to do nothing. The caret is placed
    // deliberately once the editor mounts instead.
    setup()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    fireEvent(screen.getByLabelText('Rewrite this section'), event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('shows the keyboard hint only while the part is open', () => {
    const { container } = setup()
    expect(screen.queryByText('Click outside to apply edit')).toBeNull()
    openPart(container)
    expect(screen.getByText('Click outside to apply edit')).toBeInTheDocument()
  })

  it('renders the chip inside the field as an uneditable unit', () => {
    const { container } = setup()
    const chip = openPart(container).querySelector('.inline-prose__chip')!
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.textContent).toContain('post to your finance channel')
  })
})

describe('applying and abandoning', () => {
  it('applies the edit when focus leaves the part', () => {
    const { container, props } = setup()
    const editor = openPart(container)
    editor.querySelectorAll('.inline-prose__line')[1].textContent =
      'Extract the vendor name and due date'
    fireEvent.blur(editor)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    expect(changed(props)[1].text).toBe('Extract the vendor name and due date')
  })

  it('writes a chip back as its token, not as the words it was showing', () => {
    const { container, props } = setup()
    const editor = openPart(container)
    const line = editor.querySelectorAll('.inline-prose__line')[2]
    line.insertBefore(document.createTextNode('Urgently: '), line.firstChild)
    fireEvent.blur(editor)
    expect(changed(props)[2].text).toContain('{{connector:opt-team-chat}}')
    expect(changed(props)[2].text).not.toContain('post to your finance channel')
  })

  it('drops the placeholder when the chip itself is deleted', () => {
    const { container, props } = setup()
    const editor = openPart(container)
    editor.querySelector('.inline-prose__chip')!.remove()
    fireEvent.blur(editor)
    expect(changed(props)[2].text).not.toContain('{{connector')
  })

  it('marks only the line that changed, not the whole part', () => {
    const { container, props } = setup()
    const editor = openPart(container)
    editor.querySelectorAll('.inline-prose__line')[1].textContent = 'Something else'
    fireEvent.blur(editor)
    expect(changed(props)[1].edited).toBe(true)
    expect(changed(props)[0].edited).toBeUndefined()
    expect(changed(props)[2].edited).toBeUndefined()
  })

  it('leaves the part untouched on Escape', () => {
    const { container, props } = setup()
    const editor = openPart(container)
    editor.querySelectorAll('.inline-prose__line')[1].textContent = 'something else entirely'
    fireEvent.keyDown(editor, { key: 'Escape' })
    fireEvent.blur(editor)
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('reports nothing when the text comes back identical', () => {
    const { container, props } = setup()
    fireEvent.blur(openPart(container))
    expect(props.onChange).not.toHaveBeenCalled()
  })
})

describe('deleting across lines', () => {
  it('accepts a part emptied of several lines at once', () => {
    // What a drag-select across two steps and one Delete leaves behind — the
    // thing per-line editors could not express at all.
    const { container, props } = setup()
    const editor = openPart(container)
    const lines = editor.querySelectorAll('.inline-prose__line')
    lines[1].remove()
    lines[2].remove()
    fireEvent.blur(editor)
    expect(changed(props)).toHaveLength(1)
    expect(changed(props)[0].text).toBe('**Whenever an invoice arrives:**')
  })

  it('keeps one blank line when every line is deleted', () => {
    // A part with no lines renders as nothing, and there would be nothing left
    // to click on to write it back.
    const { container, props } = setup()
    const editor = openPart(container)
    editor.replaceChildren()
    fireEvent.blur(editor)
    expect(changed(props)).toHaveLength(1)
    expect(changed(props)[0].text).toBe('')
  })

  it('reads back a line the browser left without a kind', () => {
    // Pressing Enter mid-list produces a sibling the browser may or may not
    // stamp with data-kind. An unstamped line continues the run above it.
    const { container, props } = setup()
    const editor = openPart(container)
    const fresh = document.createElement('div')
    fresh.className = 'inline-prose__line'
    fresh.append('A brand new step')
    editor.append(fresh)
    fireEvent.blur(editor)
    const blocks = changed(props)
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: 'ol', text: 'A brand new step' })
  })
})

describe('serializeEditor', () => {
  it('rebuilds source text from the edited DOM', () => {
    const root = document.createElement('div')
    root.innerHTML =
      'flag it and ' +
      '<span class="inline-prose__chip" data-token="connector:opt-team-chat">' +
      'post to your finance channel<span class="inline-prose__chip-remove">×</span></span>' +
      ' an alert'
    expect(serializeEditor(root)).toBe('flag it and {{connector:opt-team-chat}} an alert')
  })

  it('preserves bold and inline code through the round trip', () => {
    const root = document.createElement('div')
    root.innerHTML = '<strong>Note:</strong> pass <code>--force</code>'
    expect(serializeEditor(root)).toBe('**Note:** pass `--force`')
  })

  it('collapses the stray whitespace a contentEditable leaves behind', () => {
    const root = document.createElement('div')
    root.innerHTML = '  keep   this  <br>  tidy  '
    expect(serializeEditor(root)).toBe('keep this tidy')
  })
})
