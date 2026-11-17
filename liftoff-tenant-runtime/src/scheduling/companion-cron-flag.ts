// Multi-companion cron feature flag.
//
// Default: ON. Set MULTI_COMPANION_CRON_ENABLED=off explicitly to disable
// (rollback path). Companion-cron behavior is non-destructive on agents that
// don't declare companions — the helper returns an empty array and lifecycle
// code short-circuits.
export function isMultiCompanionCronEnabled(): boolean {
  return (process.env.MULTI_COMPANION_CRON_ENABLED ?? 'on').toLowerCase() !== 'off';
}
