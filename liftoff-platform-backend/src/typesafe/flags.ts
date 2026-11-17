// Kills, not flags. Each one is the switch for a code defect in one item;
// tested features default on. `0` is today's path exactly.

/** Phase 1's classifier and 1b's effect head share this umbrella. Off, the
 *  classifier never calls `ask`, no new `effect_class` is written, and both
 *  custom-MCP endpoints report the version segment `off` so the runtime
 *  refetches every entry with no effect classes appended. */
export function isTypeSafeClassifierEnabled(): boolean {
  return process.env.TYPESAFE_CLASSIFIER_ENABLED !== '0';
}

/** Phase 3's bind rung, BOTH branches: the deterministic exact/alias rebind
 *  and the Jev disambiguation. One variable restores today's behaviour. */
export function isDistillBindEnabled(): boolean {
  return process.env.DISTILL_BIND_ENABLED !== '0';
}

/** Phase 9's `suggested` rung on Slack, Teams and the dashboard threads. Off,
 *  the picker and the ILIKE rung, as today. */
export function isTypeSafeRoutingEnabled(): boolean {
  return process.env.TYPESAFE_ROUTING_ENABLED !== '0';
}

/** The Jev branch inside `guardMessage`. Off, the medium-tier generation
 *  guard exactly as today — which is also what an `ask` returning null gives,
 *  so the guard is never weaker than it was. */
export function isTypeSafeInjectionGuardEnabled(): boolean {
  return process.env.TYPESAFE_INJECTION_GUARD_ENABLED !== '0';
}
