// Reactive subscriptions feature flag.
//
// Default: ON. Set REACTIVE_SUBSCRIPTIONS_ENABLED=off explicitly to disable
// (rollback path). When ON, the subscription-router starts on boot, the
// activation lifecycle upserts reactiveSubscriptions rows, and the
// computed-metric poller + window pruner + entity-state pruner Cloud
// Scheduler jobs actually execute their work.
export function isReactiveSubscriptionsEnabled(): boolean {
  return (process.env.REACTIVE_SUBSCRIPTIONS_ENABLED ?? 'on').toLowerCase() !== 'off';
}
