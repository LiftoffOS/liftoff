// Which arguments of a held tool call a reviewer can sensibly change.
//
// The approval gate answers yes or no on the call as the agent proposed it.
// That is less than the work asks for: someone reviewing a quote adjusts the
// price and sends, someone reviewing a post fixes the wording and publishes.
// Approving an unchanged draft and correcting it somewhere else means what
// shipped was never what was reviewed.
//
// Only text and numbers are offered. An id, a nested object, a list of
// attachments: changing those by hand produces a malformed request far more
// often than a better one, and the reviewer cannot see the schema they would
// be breaking. Everything not offered is carried through untouched, so an edit
// never silently drops an argument nobody was shown.

/** Keys whose values are never shown in full and so must never be editable —
 *  the field renders as "Hidden", and an editor over a redacted value would
 *  write the mask back as the real thing. Mirrors SECRET_KEY in
 *  toolCallDetails.ts, which does the same job for the read-only view. */
const SECRET_KEY = /token|secret|password|api[-_]?key|credential|authorization/i

/** Beyond this a single line stops being a line. Body text, a message, a
 *  description: these want room, and a one-line input makes reviewing what you
 *  are about to send impossible. */
const MULTILINE_AT = 80

export interface EditableField {
  /** Top-level key in the tool input. */
  path: string
  /** The key as a person reads it. */
  label: string
  /** Always a string in the editor, converted back on the way out. */
  value: string
  multiline: boolean
  /** Kept so a number edited in a text box goes back as a number. A tool that
   *  declared an integer argument and receives "5" will reject it, and the
   *  reviewer would have no idea why. */
  numeric: boolean
}

export function editableFieldsOf(
  input: Record<string, unknown> | null | undefined,
): EditableField[] {
  if (!input) return []
  return Object.entries(input)
    .filter(([key, value]) => {
      if (SECRET_KEY.test(key)) return false
      return typeof value === 'string' || typeof value === 'number'
    })
    .map(([key, value]) => {
      const text = String(value)
      return {
        path: key,
        label: sentenceCase(key),
        value: text,
        multiline: text.length > MULTILINE_AT || text.includes('\n'),
        numeric: typeof value === 'number',
      }
    })
}

/** The whole input with one field replaced.
 *
 *  Whole, not a patch: what travels to the runtime is a replacement for the
 *  call's arguments, so every key the reviewer did not touch has to be here
 *  too. A partial object would arrive as an edit that deleted everything the
 *  editor happened not to show. */
export function withEditedFields(
  input: Record<string, unknown>,
  path: string,
  raw: string,
): Record<string, unknown> {
  const wasNumeric = typeof input[path] === 'number'
  // A number field left mid-edit ("", "-", "1.") is not a number yet. Keeping
  // the text means the box behaves while it is being typed in; a value that
  // never becomes numeric is the reviewer's to fix before they approve.
  const next = wasNumeric && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
  return { ...input, [path]: next }
}

/** Whether anything actually differs, so an approval that changed nothing is
 *  recorded as an ordinary approval rather than an override. */
export function hasRealEdits(
  original: Record<string, unknown> | null | undefined,
  edited: Record<string, unknown> | null | undefined,
): boolean {
  if (!edited) return false
  if (!original) return true
  return JSON.stringify(sortKeys(original)) !== JSON.stringify(sortKeys(edited))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

function sentenceCase(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}
