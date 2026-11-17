/** Tools whose invocation means the user's visible browser pane is about to be
 *  driven, so the pane opens the moment one is called.
 *
 *  This is the DETERMINISTIC path to opening the pane, and the only one that
 *  works regardless of where the run is executing. The other two are weaker:
 *  the SSE SESSION_CREATED event is emitted from an in-process EventEmitter and
 *  the tenant runtime has no Cloud Run session affinity, so it can be lost; and
 *  the active-session query's backstop is a 90-second refetch, which lands long
 *  after the turn has finished. If a browser tool is missing from this list, the
 *  pane opens late or not at all and the person watches a blank panel while the
 *  agent reports success.
 *
 *  Which is what happened: the list named the tools that existed when Anchor was
 *  the only vendor and was never updated when navigate_browser_session was
 *  added, so the one tool an agent reaches for to open a page was the one tool
 *  that did not open the pane. It is a hand-maintained mirror of the tenant
 *  runtime's browser tools; there is no import across the repo boundary to keep
 *  it honest, so it is covered by a test that states the whole set explicitly. */
export const BROWSER_DRIVING_TOOLS: readonly string[] = [
  // Opens a session if none exists and navigates it. The common case by far.
  'navigate_browser_session',
  // Opens a session without navigating anywhere.
  'start_browser_session',
  // Hands a multi-step task to the vendor's own in-session agent.
  'run_browser_task',
  'web_task',
  // Reads the live session, which implies one is on screen to read.
  'read_active_browser_session',
  // Takes a picture of the live session, which implies the same thing.
  'screenshot_browser_session',
  // Snapshots the page CURRENTLY OPEN in the live session as a PDF, so the same
  // thing again: it can only mean anything if a session is already on screen.
  'save_active_browser_page_as_pdf',
]

/** Browser-adjacent tools that deliberately do NOT open the pane.
 *
 *  Named here because "does it mention the browser" is the wrong test and the
 *  list has already drifted twice by using it. The right test is whether the
 *  call means the person wants to LOOK at the browser. These do not:
 *
 *  - get_browser_session_stats answers a metering question (how long, how much
 *    did this cost). Opening a browser to answer it is a non-sequitur.
 *  - fetch_browser_download / list_browser_downloads are about files the session
 *    produced, not the page it is showing.
 *  - web_session_save / list / forget / close manage stored logins, and none of
 *    them needs a session running at all.
 *  - check_browser_intervention_pending is the near miss. When something IS
 *    pending the person must look, so it reads like a fit — but the tool returns
 *    null the rest of the time and its own description offers it as a routine
 *    poll before issuing the next task. Opening the pane on a poll is how the
 *    blank panel this file exists to prevent comes back, from the other
 *    direction. If the pane should open for a pending intervention, the signal
 *    is the intervention itself, not the question. */
export const NON_PANE_BROWSER_TOOLS: readonly string[] = [
  'get_browser_session_stats',
  'fetch_browser_download',
  'list_browser_downloads',
  'check_browser_intervention_pending',
  'web_session_save',
  'web_session_list',
  'web_session_forget',
  'web_session_close',
]

/** Match an SDK-reported tool name against the bare browser-tool names.
 *
 *  The Claude Agent SDK reports MCP-registered tools as
 *  `mcp__<server>__<tool>` (see tool-gateway/mcp-server.ts), so a bare
 *  equality check against the wire value never matches on the engine that
 *  serves almost all traffic. Both spellings are accepted. */
export function isBrowserDrivingTool(reportedTool: string): boolean {
  for (const bare of BROWSER_DRIVING_TOOLS) {
    if (reportedTool === bare) return true
    if (reportedTool.endsWith(`__${bare}`)) return true
  }
  return false
}
