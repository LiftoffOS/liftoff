/** The row types the person's browser events are stored under, and the status
 *  line the client draws for a hand-back while the turn runs. Kept beside
 *  BrowserHandbackRow, in a module of its own, so the component file exports
 *  the component alone. The type spelling must match the backend constant of
 *  the same name, which is what writes the rows, and the line is spelled as
 *  the backend spells the row. */

/** Marks a row as the person's hand-back. */
export const BROWSER_HANDBACK_MESSAGE_TYPE = 'browser_handback'
/** Marks a row as a point, the Option-click gesture this client no longer
 *  offers. READ ONLY: nothing writes one any more, and the rows written while
 *  it existed are still in every thread that carried one. Drop it from the
 *  test below and those rows stop being status lines and start rendering as
 *  somebody's speech — the person would appear to have said "Alex Rivera
 *  pointed at div" out loud, months after the gesture was removed. */
export const BROWSER_POINT_MESSAGE_TYPE = 'browser_point'

/** Whether a row is a browser event row, past or present. */
export function isBrowserEventRow(messageType: string | null | undefined): boolean {
  return messageType === BROWSER_HANDBACK_MESSAGE_TYPE || messageType === BROWSER_POINT_MESSAGE_TYPE
}

/** "<name> handed the browser back": the line the client draws while the turn
 *  runs, before the persisted row arrives; the backend spells it the same. */
export function handbackStatusLine(displayName: string): string {
  return `${displayName} handed the browser back`
}

