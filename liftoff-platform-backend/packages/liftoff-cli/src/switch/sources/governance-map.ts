// Liftoff Switch — source policy to Liftoff governance rule.
//
// Only rules with EXACT Liftoff semantics are carried. A policy that half-maps
// is worse than one reported as unsupported: the user believes a guardrail
// came across, and it did not. Everything unrecognised becomes an unsupported
// item naming the policy, never a silently weakened approximation.
//
// The source products express governance mostly as prose in instruction files,
// which is not a rule and is deliberately not treated as one — that text rides
// across as instructions and informs the distiller. What this maps is the small
// set of DECLARATIVE, structured settings that have a Liftoff equivalent.

import type { ImportedGovernanceRule } from '../contract';

/** Liftoff governance kinds this importer can produce. Kept narrow on purpose. */
export type GovernanceKind =
  | 'tool_approval_required'
  | 'tool_denied'
  | 'sandbox_required'
  | 'egress_restricted';

export interface RawPolicy {
  /** Key as it appeared in the source configuration. */
  key: string;
  value: unknown;
  /** Which identity it applied to, when it was scoped to one. */
  identitySourceRef?: string;
}

interface Mapping {
  kind: GovernanceKind;
  describe: (value: unknown) => string;
}

/** Structured settings with an exact Liftoff equivalent.
 *
 *  `approvalRequired`/`requireApproval` map to Liftoff's gate; a denied tool
 *  list maps to a deny rule; a sandbox flag maps to sandboxed execution. Note
 *  what is NOT here: anything resembling "be careful", a free-text standing
 *  order, or a policy expressed as executable code. */
const MAPPINGS: Record<string, Mapping> = {
  approvalrequired: {
    kind: 'tool_approval_required',
    describe: (v) => `Tools requiring approval before running: ${describeList(v)}`,
  },
  requireapproval: {
    kind: 'tool_approval_required',
    describe: (v) => `Tools requiring approval before running: ${describeList(v)}`,
  },
  askbeforerunning: {
    kind: 'tool_approval_required',
    describe: (v) => `Tools requiring approval before running: ${describeList(v)}`,
  },
  deniedtools: {
    kind: 'tool_denied',
    describe: (v) => `Tools that must not run: ${describeList(v)}`,
  },
  blockedtools: {
    kind: 'tool_denied',
    describe: (v) => `Tools that must not run: ${describeList(v)}`,
  },
  sandbox: {
    kind: 'sandbox_required',
    describe: (v) => (isTruthy(v) ? 'Code execution runs sandboxed' : 'Sandbox was disabled'),
  },
  sandboxed: {
    kind: 'sandbox_required',
    describe: (v) => (isTruthy(v) ? 'Code execution runs sandboxed' : 'Sandbox was disabled'),
  },
  allowedhosts: {
    kind: 'egress_restricted',
    describe: (v) => `Network access limited to: ${describeList(v)}`,
  },
  allowlisthosts: {
    kind: 'egress_restricted',
    describe: (v) => `Network access limited to: ${describeList(v)}`,
  },
};

export interface GovernanceMapResult {
  rules: ImportedGovernanceRule[];
  /** Policies with no exact Liftoff equivalent, by their source key. */
  unmappedKeys: string[];
}

export function mapGovernancePolicies(
  sourcePrefix: string,
  policies: RawPolicy[],
): GovernanceMapResult {
  const rules: ImportedGovernanceRule[] = [];
  const unmappedKeys: string[] = [];

  for (const policy of policies) {
    const mapping = MAPPINGS[policy.key.toLowerCase().replace(/[_\-\s]/g, '')];
    if (!mapping) {
      unmappedKeys.push(policy.key);
      continue;
    }
    // A sandbox flag that was switched OFF is not a guardrail to import. It is
    // recorded as unmapped so the review surface can say the source ran without
    // it, rather than importing a rule that asserts the opposite.
    if (mapping.kind === 'sandbox_required' && !isTruthy(policy.value)) {
      unmappedKeys.push(policy.key);
      continue;
    }
    rules.push({
      sourceRef: `${sourcePrefix}:${policy.key}`,
      identitySourceRef: policy.identitySourceRef,
      kind: mapping.kind,
      description: mapping.describe(policy.value),
    });
  }

  return { rules, unmappedKeys };
}

function describeList(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string');
    return items.length > 0 ? items.join(', ') : 'none listed';
  }
  if (typeof value === 'string') return value;
  return 'none listed';
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}