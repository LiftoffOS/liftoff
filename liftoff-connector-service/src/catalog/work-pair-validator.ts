// W1.2 — boot-time work-pair validator.
//
// Walks the entire connector-functions registry and asserts that every
// `workRole='inbox'` tool resolves to a `workRole='ack'` tool in the same
// connector with the same `workItemKind`, and vice versa for ack →
// inbox. If any pair is broken, the process is intended to refuse to
// start.
//
// Agents that process queues of work items via cron-polling are
// vulnerable to the repeat-reply spam class of failure (re-replying to the same
// message when memory dedup fails). Tagging the pair at the registry
// makes the distill prompt auto-inject an acknowledgement contract that
// the agent must respect, and the validator here ensures every
// registered pair is internally consistent before the service comes up.
//
// Validation is intentionally pure-function for testability: callers
// supply the registry and decide what to do with violations. The
// production caller (connector-functions-registry.ts module load) calls
// `assertNoViolations(...)` which logs each violation and `process.exit(1)`.

import type { ConnectorFunction } from '../types.js';

export type WorkPairViolationReason =
  | 'inbox_missing_paired_ack'
  | 'inbox_missing_workItemKind'
  | 'ack_missing_acknowledges'
  | 'ack_missing_workItemKind'
  | 'paired_ack_not_found_in_connector'
  | 'acknowledges_not_found_in_connector'
  | 'paired_ack_target_has_wrong_role'
  | 'acknowledges_target_has_wrong_role'
  | 'workItemKind_mismatch';

export interface WorkPairViolation {
  connectorType: string;
  toolName: string;
  reason: WorkPairViolationReason;
  detail: string;
}

/**
 * Validate every connector's function set. Returns a flat list of
 * violations (empty when the registry is consistent). Pure function —
 * no logging, no exit.
 *
 * Time complexity is O(total functions). Builds one Map per connector
 * for O(1) name lookup.
 */
export function validateWorkPairs(
  registry: Record<string, ConnectorFunction[]>,
): WorkPairViolation[] {
  const violations: WorkPairViolation[] = [];

  for (const [connectorType, fns] of Object.entries(registry)) {
    const byName = new Map<string, ConnectorFunction>(fns.map((f) => [f.name, f]));

    for (const fn of fns) {
      if (fn.workRole === 'inbox') {
        if (!fn.paired_ack) {
          violations.push({
            connectorType,
            toolName: fn.name,
            reason: 'inbox_missing_paired_ack',
            detail: `workRole='inbox' but paired_ack is unset on ${connectorType}.${fn.name}`,
          });
        }
        if (!fn.workItemKind) {
          violations.push({
            connectorType,
            toolName: fn.name,
            reason: 'inbox_missing_workItemKind',
            detail: `workRole='inbox' but workItemKind is unset on ${connectorType}.${fn.name}`,
          });
        }
        if (fn.paired_ack) {
          const target = byName.get(fn.paired_ack);
          if (!target) {
            violations.push({
              connectorType,
              toolName: fn.name,
              reason: 'paired_ack_not_found_in_connector',
              detail: `paired_ack='${fn.paired_ack}' on ${connectorType}.${fn.name} does not resolve to a function in the same connector`,
            });
          } else {
            if (target.workRole !== 'ack') {
              violations.push({
                connectorType,
                toolName: fn.name,
                reason: 'paired_ack_target_has_wrong_role',
                detail: `paired_ack='${fn.paired_ack}' on ${connectorType}.${fn.name} resolves to a function with workRole=${target.workRole ?? 'unset'}, expected 'ack'`,
              });
            }
            if (fn.workItemKind && target.workItemKind && fn.workItemKind !== target.workItemKind) {
              violations.push({
                connectorType,
                toolName: fn.name,
                reason: 'workItemKind_mismatch',
                detail: `${connectorType}.${fn.name} declares workItemKind='${fn.workItemKind}' but paired ack ${connectorType}.${target.name} declares workItemKind='${target.workItemKind}'`,
              });
            }
          }
        }
      }

      if (fn.workRole === 'ack') {
        if (!fn.acknowledges) {
          violations.push({
            connectorType,
            toolName: fn.name,
            reason: 'ack_missing_acknowledges',
            detail: `workRole='ack' but acknowledges is unset on ${connectorType}.${fn.name}`,
          });
        }
        if (!fn.workItemKind) {
          violations.push({
            connectorType,
            toolName: fn.name,
            reason: 'ack_missing_workItemKind',
            detail: `workRole='ack' but workItemKind is unset on ${connectorType}.${fn.name}`,
          });
        }
        if (fn.acknowledges) {
          const target = byName.get(fn.acknowledges);
          if (!target) {
            violations.push({
              connectorType,
              toolName: fn.name,
              reason: 'acknowledges_not_found_in_connector',
              detail: `acknowledges='${fn.acknowledges}' on ${connectorType}.${fn.name} does not resolve to a function in the same connector`,
            });
          } else if (target.workRole !== 'inbox') {
            violations.push({
              connectorType,
              toolName: fn.name,
              reason: 'acknowledges_target_has_wrong_role',
              detail: `acknowledges='${fn.acknowledges}' on ${connectorType}.${fn.name} resolves to a function with workRole=${target.workRole ?? 'unset'}, expected 'inbox'`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Production caller: log every violation to stderr and exit non-zero if
 * any are present. Used at connector-functions-registry.ts module load so
 * a broken registry refuses to deploy.
 *
 * Kept as a separate function from `validateWorkPairs` so tests can
 * assert on the pure validator without intercepting process.exit.
 */
export function assertNoViolations(violations: readonly WorkPairViolation[]): void {
  if (violations.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(
    `[connector-service] FATAL: work-pair validation failed with ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${v.connectorType}.${v.toolName} → ${v.reason}: ${v.detail}`);
  }
  process.exit(1);
}
