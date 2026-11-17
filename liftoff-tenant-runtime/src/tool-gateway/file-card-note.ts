// The one line the host tells the model about a file card.
//
// A tool result says the tool succeeded; it cannot say what the SURFACE did
// with the file, and a model that infers "attached below" from a success
// narrates a card that may not exist. So the host asserts the fact itself,
// once, only when the platform answered `cardAppended: true` for the
// registration — never on a file id alone, never on a timeout, never on a
// failure — and the model repeats a fact instead of inferring one.
//
// One string, shared by the found-file path and the document tools, so the
// two producers of a card say the same thing.

/** The host-authored line for a file that is now a card on the conversation. */
export function fileCardHostNote(name: string): string {
  return `Attached to this conversation as a file card: ${name}.`;
}

/** Text to append after a framed tool result, or nothing. The note goes
 *  OUTSIDE the untrusted frame: it is the host speaking, not the vendor. */
export function hostNoteSuffix(note: string | undefined): string {
  return note ? `\n\n${note}` : '';
}
