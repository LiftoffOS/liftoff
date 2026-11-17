// Pure, DB-free risk taxonomy for the HITL gate.
//
// Kept OUT of ./service (which is DB-backed and mocked wholesale in tests) so
// both the per-action Authorize hot path (rpc/router.ts) and the batch
// checkHitlGate share one source of truth without any test-mock coupling.

import { SUPER_DESTRUCTIVE_OPERATIONS } from './types';

export { SUPER_DESTRUCTIVE_OPERATIONS };

/**
 * Name-based gate sets hold BARE action names (e.g. `merge_pull_request`), but
 * every runtime tool-call name is dispatch-prefixed (`<alias>__<tool>` /
 * `mcp__<server>__<tool>`). A raw `set.has(prefixedName)` never matches,
 * silently disabling the gate. Normalize to the bare action (after the last
 * `__`) and check both forms.
 */
export function toolActionMatchesNameSet(set: ReadonlySet<string>, toolName: string): boolean {
  if (set.has(toolName)) return true;
  const sep = toolName.lastIndexOf('__');
  return sep >= 0 && set.has(toolName.slice(sep + 2));
}

/**
 * Merge / land operations across GitHub and GitLab. These land a change onto a
 * branch and are treated as CONSEQUENTIAL: the per-action Authorize path
 * requires a human at EVERY autonomy level (opening a change for review is not
 * the same risk as merging it).
 */
export const MERGE_TO_MAIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  // GitHub
  'merge_pull_request',
  'squash_and_merge_pull_request',
  'merge_branch',
  // GitLab
  'accept_merge_request',
  'merge_merge_request',
]);

/**
 * Reversible, low-risk collaboration writes: opening a change for review and
 * commenting on it. These are trivially reversible (close the PR/MR, delete the
 * comment) and are NOT the consequential act — merging is. They proceed once
 * autonomy reaches 'balanced' (HITL level >= 3) instead of gating like a merge.
 * Curated opt-in allow-list: anything not listed keeps the default level gate.
 */
export const LOW_RISK_REVERSIBLE_WRITES: ReadonlySet<string> = new Set([
  // open a change for review
  'create_pull_request',
  'create_merge_request',
  // review comments / notes
  'create_merge_request_note',
  'create_issue_comment',
  'create_pull_request_review',
  'add_comment',
]);

/**
 * Whole-token verb classification for action NAMES — the Authorize hot path
 * has no tool definitions, so read-ness is inferred from the name exactly the
 * way tenant-runtime's classifyVendorToolEffect does (tool-gateway/
 * tool-effect.ts — keep the verb lists in lockstep). Mutating wins over read
 * (`get_or_create_x` is a write); an unrecognized verb is NOT a read.
 *
 * Why: if the level 1-3 gate in rpc/router.ts applies to EVERY action
 * without checking read-ness, then at balanced autonomy the native connector
 * path HITL-gates pure reads (e.g. slack list_channels denied with
 * decision=HITL_REQUIRED). Reads now gate only at
 * level 1 — parity with the batch checkHitlGate, where level 1 gates
 * everything and levels 2-3 pass unclassified reads.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  'get', 'list', 'read', 'search', 'fetch', 'describe', 'view', 'download', 'count',
]);
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'write', 'send',
  'merge', 'insert', 'upsert', 'patch', 'put', 'edit', 'modify', 'replace',
  'move', 'rename', 'archive', 'restore', 'publish', 'unpublish', 'deploy',
  'cancel', 'approve', 'reject', 'assign', 'unassign', 'invite', 'revoke',
  'grant', 'enable', 'disable', 'submit', 'execute', 'trigger', 'import',
  'export', 'upload', 'lock', 'unlock', 'subscribe', 'unsubscribe', 'transfer',
  'convert', 'clear', 'reset', 'dismiss', 'refund', 'charge', 'pay', 'apply',
]);

function tokenizeActionName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** True only when the action name carries a read verb and no mutating verb. */
export function isReadOnlyActionName(toolName: string): boolean {
  const sep = toolName.lastIndexOf('__');
  const bare = sep >= 0 ? toolName.slice(sep + 2) : toolName;
  const tokens = tokenizeActionName(bare);
  if (tokens.some((t) => MUTATING_VERBS.has(t))) return false;
  return tokens.some((t) => READ_VERBS.has(t));
}

/**
 * Connector-SCOPED reversible low-risk writes, keyed `<connectorType>.<action>`.
 * Scoping is load-bearing: a bare `send_message` entry in the name-only set
 * above would also exempt microsoft_outlook_mail's send_message — an EMAIL
 * send, which is not reversible. Slack/Teams channel messages are internal
 * team collaboration (deletable, non-consequential) and proceed at balanced
 * (level >= 3), same policy shape as opening a PR for review.
 */
export const LOW_RISK_REVERSIBLE_WRITES_SCOPED: ReadonlySet<string> = new Set([
  'slack.send_message',
  'slack.add_reaction',
  'microsoft_teams.send_message',
]);

/**
 * Match a scoped entry. `connector` arrives instance-suffixed from the
 * gateway (`slack-d77db9a0`); the type is everything before the trailing
 * 8-hex-char instance id. Falls back to the raw connector for un-suffixed
 * callers.
 */
export function scopedActionMatchesNameSet(
  set: ReadonlySet<string>,
  connector: string,
  toolName: string,
): boolean {
  const sep = toolName.lastIndexOf('__');
  const bare = sep >= 0 ? toolName.slice(sep + 2) : toolName;
  const type = connector.replace(/-[0-9a-f]{8}$/i, '');
  return set.has(`${type}.${bare}`) || set.has(`${connector}.${bare}`);
}
