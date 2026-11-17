// Part 5 §D — delegation default + hard-cap constants.
//
// Defaults can be overridden per-tenant via tenant_runtime_config (Part 3);
// hard caps are immutable in code so a misconfigured row cannot blow past
// the shared-infra budget. See plan §D for the capacity-arithmetic table
// that motivated each number.

export const DELEGATION_DEFAULTS = {
  // Depth 2 = A can hand work to B, and B can hand it on to C. One link was too
  // tight for real chains (Release Manager → QA → Security Review is ordinary
  // work, not a runaway), and the ceiling of 3 leaves one notch of per-workspace
  // headroom for a genuinely longer chain.
  //
  // Watch the MULTIPLIER, not this number alone: a tree is depth × fan-out, and
  // MAX_FANOUT is 16 — so depth 1 is 16 potential runs, depth 2 is 272, depth 3
  // is 4,368. If this is ever raised to 3, lower MAX_FANOUT in the same change.
  MAX_DEPTH:          parseInt(process.env.MAX_DELEGATION_DEPTH ?? '2', 10),
  MAX_FANOUT:         parseInt(process.env.MAX_DELEGATION_FANOUT ?? '16', 10),
  DEFAULT_CONCURRENT: parseInt(process.env.DEFAULT_MAX_CONCURRENT_CHILDREN ?? '8', 10),
  // How many delegated runs of ONE agent may be in flight at once, workspace
  // wide (migration 367). Children bypass the per-agent execution lock —
  // taking it would serialise a fan-out to one specialist and deadlock
  // self-delegation — so this cap is what bounds them instead.
  PER_AGENT_CHILDREN: parseInt(process.env.MAX_CHILDREN_PER_AGENT ?? '3', 10),
};

export const DELEGATION_HARD_CAPS = {
  MAX_DEPTH: 3,
  MAX_FANOUT: 64,
  DEFAULT_CONCURRENT: 32,
  PER_AGENT_CHILDREN: 16,
};

/** Clamp a tenant-supplied value into [1, hardCap]. The floor of 1 protects
 *  against operator typos (`0` would silently break fan-out). The min keeps
 *  hardCap as the effective ceiling. NULL → use the in-code default.
 *
 *  When the tenant-supplied value exceeds the hard cap, emit
 *  tenant_config_clamped_total{key} so the operator dashboard surfaces
 *  config drift. */
export function applyClamp(
  tenantValue: number | null,
  defaultValue: number,
  hardCap: number,
  key?: string,
): number {
  if (tenantValue !== null && tenantValue > hardCap && key) {
    // Late-bind the metrics module so this file stays standalone-testable.
     
    require('../observability/runtime-extensions-metrics').tenant_config_clamped_total.inc({ key });
  }
  return Math.max(1, Math.min(tenantValue ?? defaultValue, hardCap));
}
