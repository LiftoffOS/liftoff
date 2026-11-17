/** Compute pixel position of a character offset inside a plain <textarea>.
 *
 *  The web platform provides no native way to get caret pixel position from a
 *  textarea (unlike contentEditable). This uses the mirror-div technique:
 *  create an invisible div that mirrors the textarea's layout-affecting styles
 *  (font, padding, border, box-sizing, etc.), fill it with text up to the
 *  target offset + a marker span, and read the marker's bounding rect.
 *
 *  Layout is cached per textarea so repeated calls are cheap. The mirror div
 *  is positioned at the textarea's viewport-rect shifted by scrollTop to
 *  account for internal scrolling.
 */

let mirrorDiv: HTMLDivElement | null = null
let lastTextarea: HTMLTextAreaElement | null = null

const LAYOUT_STYLES = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'MozTabSize',
  'whiteSpace',
  'wordWrap',
  'wordBreak',
  'overflowWrap',
] as const

function getMirrorDiv(textarea: HTMLTextAreaElement): HTMLDivElement {
  if (mirrorDiv && lastTextarea === textarea) {
    return mirrorDiv
  }

  if (!mirrorDiv) {
    mirrorDiv = document.createElement('div')
    mirrorDiv.style.position = 'fixed'
    mirrorDiv.style.visibility = 'hidden'
    mirrorDiv.style.whiteSpace = 'pre-wrap'
    mirrorDiv.style.wordWrap = 'break-word'
    mirrorDiv.style.overflowWrap = 'break-word'
    document.body.appendChild(mirrorDiv)
  }

  const computedStyle = window.getComputedStyle(textarea)

  for (const styleName of LAYOUT_STYLES) {
    const value = computedStyle.getPropertyValue(styleName)
    mirrorDiv.style.setProperty(styleName, value)
  }

  lastTextarea = textarea
  return mirrorDiv
}

/** Get the pixel rect (viewport coords) of a character offset in a textarea.
 *  Accounts for the textarea's internal scrollTop. Returns DOMRect with
 *  top/left in viewport coordinates. */
export function getCaretRect(textarea: HTMLTextAreaElement, index: number): DOMRect {
  const mirrorDiv = getMirrorDiv(textarea)

  const text = textarea.value.slice(0, Math.max(0, index))
  const marker = document.createElement('span')
  marker.textContent = '|'

  mirrorDiv.textContent = ''
  mirrorDiv.appendChild(document.createTextNode(text))
  mirrorDiv.appendChild(marker)

  const textareaRect = textarea.getBoundingClientRect()
  mirrorDiv.style.top = `${textareaRect.top - textarea.scrollTop}px`
  mirrorDiv.style.left = `${textareaRect.left}px`

  const markerRect = marker.getBoundingClientRect()

  return new DOMRect(
    markerRect.left,
    markerRect.top,
    markerRect.width,
    markerRect.height,
  )
}
