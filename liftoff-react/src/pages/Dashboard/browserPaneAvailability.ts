/** Connectors that can OWN a thread's browser, and therefore drive the
 *  live-view pane.
 *
 *  Mirrors SESSION_VENDOR_PREFERENCE in the tenant runtime's
 *  browser-sessions/session-vendor-proxy.ts and must stay in step with it: this
 *  list decides whether the affordance APPEARS, that one decides whether a
 *  spawn can SUCCEED. The two disagreeing shows up either as a button that does
 *  nothing, or — as happened when Browser Use first shipped — as an agent with
 *  a working browser and no way to open it.
 *
 *  browserbase was deliberately absent from both for a long time: it reported
 *  session support while implementing one of the ten pane operations, so it
 *  could not drive this view. It implements all of them now and takes the slot
 *  that was reserved for it. */
export const SESSION_BROWSER_CONNECTORS = [
  'anchor_browser', 'browserbase', 'steel', 'browser_use',
] as const;

/** Whether the browser pane should be offered for this agent.
 *
 *  TWO routes to a browser, and the check has to accept both because
 *  selectSessionVendor in the runtime does:
 *
 *  1. A connector the WORKSPACE brought. Requires both halves, mirroring the
 *     runtime's `byokAgent(...)` check: the AGENT is bound to a session-capable
 *     connector, AND the tenant has that connector ACTIVE, because the
 *     credential has to exist for a session to start at all. Tenant connection
 *     alone over-promised — the affordance appeared for agents that could not
 *     browse, so asking one to navigate got a persona refusal. The two halves
 *     may be satisfied by different vendors, and that is correct: an agent bound
 *     to both Anchor and Browser Use with only one connected should still get a
 *     pane, because the runtime's preference order picks whichever is available.
 *
 *  2. The PLATFORM's own key (Steel, else Browser Use), which backs a browser
 *     for every workspace including one that connected nothing. Binding does not gate this
 *     tier for the same reason it does not gate web research: it is a capability
 *     the product has, not one the workspace brought. `platformBrowserAvailable`
 *     comes from usePlatformBrowser, which reads the same two operator
 *     kill-switches the runtime reads.
 *
 *  Leaving route 2 out is not a smaller mistake than leaving out route 1. This
 *  flag gates the toggle AND the pane itself, so an agent would drive a browser
 *  nobody could open or watch — the exact failure the second paragraph of this
 *  file's header describes, arriving from the other direction. */
export function isBrowserPaneAvailable(
  agentIntegrationIds: readonly string[],
  connectors: readonly { type: string; status: string }[],
  platformBrowserAvailable = false,
): boolean {
  const capable = SESSION_BROWSER_CONNECTORS as readonly string[];
  const bound = agentIntegrationIds.filter((id) => capable.includes(id));
  const own =
    bound.length > 0
    && connectors.some((c) => capable.includes(c.type) && c.status === 'active');
  return own || platformBrowserAvailable;
}

/** Whether a change in the current thread id should close an open browser pane.
 *
 *  Per-thread sessions are independent, so navigating to a different
 *  conversation should not leave the previous conversation's pane on screen.
 *
 *  But the FIRST thread being created is not a switch. Pressing the browser
 *  toggle on a chat with no thread yet opens the pane and then creates one, so
 *  the id goes null -> real. Treating that as a switch closed the pane a frame
 *  after the user opened it, and the session arriving reopened it: the
 *  open/close/open flicker. Only a move between two real, different threads
 *  counts. */
export function shouldClosePaneOnThreadChange(
  previousThreadId: string | null,
  currentThreadId: string | null,
): boolean {
  if (!previousThreadId || !currentThreadId) return false;
  return previousThreadId !== currentThreadId;
}
