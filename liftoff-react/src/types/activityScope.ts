/** Scope state passed via router.state when routing to the Activity page from
 *  the Teams page "Inspect Team" action. The Activity page consumes it once on
 *  mount to pre-fill its search box.
 *
 *  It rides router state rather than the URL on purpose: /dashboard/activity
 *  stays a clean, shareable address, and no team identifier is ever exposed in
 *  the address bar. Same reasoning as [ChatSeedState]. */

/** Everything the Activity page may be handed through router state. */
export interface ActivityLocationState {
  /** Deep link from the dashboard feed: open this row's detail pane. */
  selectedLogId?: string
  /** Deep link from Teams: the team's name, typed into the search box for the
   *  user so they do not have to go and search for their own team. */
  teamSearch?: string
}
