// Boot-time staged-write pairing validator.
//
// `writeRole: 'stage'` says another tool commits what this one prepares, and
// `paired_apply` says which. The pair is the whole mechanism: a job that is N
// line-level writes gets ONE approval covering the staged batch instead of
// pausing per line, and the single mark covers exactly what the apply commits.
//
// A HALF-DECLARED PAIR IS WORSE THAN NONE. A stage whose apply does not resolve
// leaves work prepared and never committed — the person approves a batch, the
// agent reports it staged, and nothing lands. An apply pointing at a tool that
// is not a stage commits something nobody staged. Neither errors: the runtime
// simply does not find the other half, and "no pair" is the same state as "not
// opted in", so the feature reads as switched off rather than broken.
//
// Same posture and same shape as work-pair-validator.ts beside it, deliberately.
// That validator exists because an inbox with no ack re-processes the same item
// forever; this one exists because a stage with no apply drops the work. Two
// symmetrical halves of one convention, so they are two files with one style
// rather than one file doing both jobs slightly differently.
//
// Pure function for testability; the production caller is the module-load
// assertion in connector-functions-registry.ts, which logs and exits non-zero.

import type { ConnectorFunction } from '../types.js';

export type WritePairViolationReason =
  | 'stage_missing_paired_apply'
  | 'paired_apply_not_found_in_connector'
  | 'paired_apply_target_has_wrong_role'
  | 'apply_declared_without_a_stage'
  | 'paired_apply_set_without_stage_role'
  | 'unknown_write_role';

export interface WritePairViolation {
  connectorType: string;
  toolName: string;
  reason: WritePairViolationReason;
  detail: string;
}

const KNOWN_ROLES = new Set(['stage', 'apply', 'direct']);

/**
 * Validate every connector's staged-write declarations.
 *
 * O(total functions), one Map per connector for O(1) name lookup. Pure — no
 * logging, no exit.
 */
export function validateWritePairs(
  registry: Record<string, readonly ConnectorFunction[]>,
): WritePairViolation[] {
  const violations: WritePairViolation[] = [];

  for (const [connectorType, fns] of Object.entries(registry)) {
    const byName = new Map(fns.map((f) => [f.name, f]));
    const appliesClaimed = new Set(
      fns.filter((f) => f.writeRole === 'stage' && f.paired_apply).map((f) => f.paired_apply!),
    );

    for (const fn of fns) {
      if (fn.writeRole !== undefined && !KNOWN_ROLES.has(fn.writeRole)) {
        violations.push({
          connectorType,
          toolName: fn.name,
          reason: 'unknown_write_role',
          detail:
            `${connectorType}.${fn.name} declares writeRole='${fn.writeRole}', which no consumer `
            + `matches on. Use one of ${[...KNOWN_ROLES].join(', ')}, or leave it unset.`,
        });
        continue;
      }

      if (fn.paired_apply && fn.writeRole !== 'stage') {
        // A pairing on a tool that does not stage anything. The runtime looks
        // up `paired_apply` only for a stage, so this declaration does nothing
        // and reads, in the source, exactly like one that does.
        violations.push({
          connectorType,
          toolName: fn.name,
          reason: 'paired_apply_set_without_stage_role',
          detail:
            `${connectorType}.${fn.name} sets paired_apply='${fn.paired_apply}' but its writeRole `
            + `is ${fn.writeRole ?? 'unset'}. Only a stage is paired with an apply.`,
        });
      }

      if (fn.writeRole === 'stage') {
        if (!fn.paired_apply) {
          violations.push({
            connectorType,
            toolName: fn.name,
            reason: 'stage_missing_paired_apply',
            detail:
              `${connectorType}.${fn.name} declares writeRole='stage' with no paired_apply, so `
              + `nothing commits what it prepares. Work would be staged and silently dropped.`,
          });
        } else {
          const target = byName.get(fn.paired_apply);
          if (!target) {
            violations.push({
              connectorType,
              toolName: fn.name,
              reason: 'paired_apply_not_found_in_connector',
              detail:
                `paired_apply='${fn.paired_apply}' on ${connectorType}.${fn.name} resolves to no `
                + `function in the same connector. Use the bare registry name, not a per-account alias.`,
            });
          } else if (target.writeRole !== 'apply') {
            violations.push({
              connectorType,
              toolName: fn.name,
              reason: 'paired_apply_target_has_wrong_role',
              detail:
                `paired_apply='${fn.paired_apply}' on ${connectorType}.${fn.name} resolves to a `
                + `function with writeRole=${target.writeRole ?? 'unset'}, expected 'apply'.`,
            });
          }
        }
      }

      if (fn.writeRole === 'apply' && !appliesClaimed.has(fn.name)) {
        // An apply nothing stages for. It would commit something no stage
        // prepared, which is the half of the pair that can actually cause a
        // write nobody approved.
        violations.push({
          connectorType,
          toolName: fn.name,
          reason: 'apply_declared_without_a_stage',
          detail:
            `${connectorType}.${fn.name} declares writeRole='apply' but no function in this `
            + `connector names it as its paired_apply, so it commits work nothing staged.`,
        });
      }
    }
  }

  return violations;
}

/**
 * Production caller: log every violation and exit non-zero. Separate from the
 * pure validator so tests can assert on it without intercepting process.exit.
 */
export function assertNoWritePairViolations(violations: readonly WritePairViolation[]): void {
  if (violations.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(
    `[connector-service] FATAL: staged-write pairing failed with ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${v.connectorType}.${v.toolName} → ${v.reason}: ${v.detail}`);
  }
  process.exit(1);
}
