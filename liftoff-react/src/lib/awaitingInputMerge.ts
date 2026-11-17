// Merging the synthetic awaiting-input bubble into the persisted transcript.
//
// When a turn pauses to ask the person a question, the runtime sends one
// terminal `awaiting_input` frame carrying the question and closes the stream.
// The page renders that question immediately from local state, because for a
// long time it was the ONLY copy: the backend persisted a reply only when a
// turn ran to completion, so a paused turn's question lived in the live bubble
// and died with it.
//
// The backend now persists the question, and the stream's closing refetch
// brings back a real row saying exactly the same thing. Appending the local
// copy on top of that rendered the question twice.
//
// So the local copy is a stand-in with a defined hand-over: show it until the
// persisted row arrives, then stand down. Keeping it until then means no gap
// between the frame and the refetch, and a backend that still persists nothing
// degrades to the old behaviour rather than to a blank pause.

/** The subset of a rendered message this merge actually reads. */
interface MergeableMessage {
  role: string
  content: string
}

/**
 * Append the synthetic awaiting-input message unless the persisted list already
 * carries it.
 *
 * Matched on role + content rather than id: the two copies are minted by
 * different systems and never share an id, and the content is what the reader
 * would see duplicated.
 */
export function mergeAwaitingInputMessage<T extends MergeableMessage>(
  persisted: T[],
  awaitingInput: T | null,
): T[] {
  if (!awaitingInput) return persisted
  const alreadyPersisted = persisted.some(
    m => m.role === 'assistant' && m.content === awaitingInput.content,
  )
  return alreadyPersisted ? persisted : [...persisted, awaitingInput]
}
