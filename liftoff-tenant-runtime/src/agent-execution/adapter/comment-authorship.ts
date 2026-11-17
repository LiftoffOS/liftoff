// Stamp the authoring team onto comments written to a code host.
//
// WHY THIS EXISTS
// A GitHub App installation has exactly one bot identity, so every team writes
// to a pull request as the same `<app>[bot]` account. Nothing on the PR says
// whether a finding came from the Code Reviewer, the Security Engineer or the
// Performance Engineer, and a person reading the thread cannot tell which of
// their agents to talk to. GitLab has the same shape.
//
// This used to be handled by asking the model to sign its reviews, as a line in
// two of the three reviewer templates. That is unenforceable (a model can
// simply not do it) and it was applied inconsistently — Code Reviewer, the one
// most likely to run on every PR, never had it. Those instructions were removed
// in favour of this, which the model cannot skip.
//
// WHERE IT RUNS
// Two seams, because the engines genuinely differ:
//   - Anthropic: the SDK opens its own transport to the vendor MCP, so the
//     arguments never pass through our process. But the SDK asks permission
//     first, and `canUseTool` may return a rewritten input.
//   - Every other engine: remote servers are proxied through our own pooled
//     client, so `dispatchFunctionCall` sees the arguments directly.
// Both call `applyCommentAuthorship`; neither is sufficient alone.
//
// MATCHING BY SHAPE, NOT BY NAME
// Tool names are discovered from the vendor at runtime, so an allowlist rots
// silently the moment GitHub adds or renames a tool — and silence here means
// unattributed comments, not an error. Verified live, the same run posts via
// `add_comment_to_pending_review`, `add_issue_comment` AND
// `pull_request_review_write`, all carrying `body`. So: scope by the server the
// tool belongs to, then by the presence of a body-shaped argument.

import { getPoolForService } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';

/** Tool names arrive namespaced by their MCP server, which carries the
 *  connector instance id: `mcp__github-dd4c4689__add_issue_comment`. */
const CODE_HOST_TOOL = /^mcp__(github|gitlab)[-_]/i;

/** The argument a comment body lands in on both hosts. */
const BODY_KEY = 'body';

/** Rendered ahead of the body. Kept on its own line so the finding still opens
 *  the comment, which is what a reviewer actually reads first. */
export function authorshipPrefix(teamName: string): string {
  return `**${teamName}** · Liftoff`;
}

/** Per-invocation role cache. A run posts several comments and they all carry
 *  the same name, so this is one query per run rather than one per comment. */
const roleByInvocation = new Map<string, string | null>();

/** Bounded, because this process outlives any single run.
 *
 *  Eviction is the cache's own job rather than a teardown hook: the adapters
 *  that release the MCP client pool at end-of-run are exactly the ones this
 *  matters least for, and the Anthropic engine — which never touches that pool,
 *  and is the engine posting these reviews — has no equivalent seam. A
 *  per-adapter hook would have left the busiest path leaking. */
const MAX_CACHED_INVOCATIONS = 500;

function rememberRole(invocationId: string, name: string | null): void {
  if (roleByInvocation.size >= MAX_CACHED_INVOCATIONS) {
    // Map iterates in insertion order, so this is the oldest entry. An entry is
    // only useful for the length of one run, so FIFO is the right eviction.
    const oldest = roleByInvocation.keys().next().value;
    if (oldest !== undefined) roleByInvocation.delete(oldest);
  }
  roleByInvocation.set(invocationId, name);
}

/** Test seam — the cache is process-lifetime otherwise. */
export function _resetAuthorshipCacheForTesting(): void {
  roleByInvocation.clear();
}

async function resolveTeamName(
  tenantId: string,
  invocationId: string,
): Promise<string | null> {
  const cached = roleByInvocation.get(invocationId);
  if (cached !== undefined) return cached;

  let name: string | null = null;
  try {
    const pool = getPoolForService('scheduled-execution');
    // Joined rather than passed in: neither seam carries the agent id, and
    // threading one through InvocationInput plus five adapters to save a
    // cached-once query is not worth the churn.
    const result = await pool.query(
      `SELECT a.role
         FROM invocations i
         JOIN agents a ON a.id = i.agent_id
        WHERE i.id = $1 AND i.tenant_id = $2`,
      [invocationId, tenantId],
    );
    const role = result.rows[0]?.role;
    name = typeof role === 'string' && role.trim() ? role.trim() : null;
  } catch (err) {
    // Never block a comment on attribution. An unstamped comment is a cosmetic
    // loss; a failed review is not.
    logger.warn(
      { tenant_id: tenantId, invocation_id: invocationId, error: (err as Error).message },
      'comment-authorship: could not resolve team name — posting unstamped',
    );
  }

  rememberRole(invocationId, name);
  return name;
}

/**
 * Returns `args` with the authoring team prefixed onto the comment body, or the
 * original object when this is not a code-host comment.
 *
 * Safe to call on every tool: non-matching calls return the same reference
 * without touching the database.
 */
export async function applyCommentAuthorship(
  toolName: string,
  args: Record<string, unknown> | undefined,
  ctx: { tenantId: string; invocationId: string | null },
): Promise<Record<string, unknown> | undefined> {
  if (!args || !ctx.invocationId) return args;
  if (!CODE_HOST_TOOL.test(toolName)) return args;

  const body = args[BODY_KEY];
  if (typeof body !== 'string' || !body.trim()) return args;

  const teamName = await resolveTeamName(ctx.tenantId, ctx.invocationId);
  if (!teamName) return args;

  const prefix = authorshipPrefix(teamName);
  // A run can retry a call, and a resumed run replays it. Stamping twice would
  // look like a bug to the reader.
  if (body.startsWith(prefix)) return args;

  return { ...args, [BODY_KEY]: `${prefix}\n\n${body}` };
}
