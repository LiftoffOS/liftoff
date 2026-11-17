// Resolve a Liftoff account → Slack user ID for a given workspace.
// Hits a 7-day TTL cache first; on miss/expiry calls users.lookupByEmail
// with the per-workspace bot token. Returns null when the account email
// isn't a member of the workspace.
//
// Also supports reverse resolution (slack_user → account) used by the
// interactivity router to authenticate button-tap actors. The reverse
// path is cache-only — there is no Slack API to invert users.lookupByEmail.
// On cache miss, the caller falls back to review_slack_messages.assignee_account_id.

import { withAdminScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { slackApiFetch, SlackApiError } from './slack-api';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SlackIdentity {
  slackTeamId: string;
  slackUserId: string;
}

interface CacheRow {
  slack_user_id: string;
  resolved_at: Date;
}

export async function resolveSlackIdentity(opts: {
  accountId: string;
  accountEmail: string;
  slackTeamId: string;
  botToken: string;
}): Promise<SlackIdentity | null> {
  const cached = await withAdminScope(
    { caller: 'slack-identity-resolver', reason: 'identity cache read' },
    (c) => c.query<CacheRow>(
      `SELECT slack_user_id, resolved_at FROM account_slack_identities
       WHERE account_id = $1 AND slack_team_id = $2`,
      [opts.accountId, opts.slackTeamId],
    ),
  );
  const row = cached.rows[0];
  if (row && Date.now() - row.resolved_at.getTime() < TTL_MS) {
    return { slackTeamId: opts.slackTeamId, slackUserId: row.slack_user_id };
  }

  try {
    const res = await slackApiFetch('users.lookupByEmail', {
      authToken: opts.botToken,
      body: { kind: 'form', value: { email: opts.accountEmail } },
    });
    if (!res.ok || typeof (res.user as { id?: string })?.id !== 'string') {
      log.info(
        { accountId: opts.accountId, slackTeamId: opts.slackTeamId, slackError: res.error },
        'slack identity not resolvable',
      );
      return null;
    }
    const slackUserId = (res.user as { id: string }).id;

    await withAdminScope(
      { caller: 'slack-identity-resolver', reason: 'identity cache write' },
      (c) => c.query(
        `INSERT INTO account_slack_identities (account_id, slack_team_id, slack_user_id, resolved_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (account_id, slack_team_id)
         DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id, resolved_at = NOW()`,
        [opts.accountId, opts.slackTeamId, slackUserId],
      ),
    );
    return { slackTeamId: opts.slackTeamId, slackUserId };
  } catch (err) {
    if (err instanceof SlackApiError) {
      log.warn({ accountId: opts.accountId, slackTeamId: opts.slackTeamId, err: err.message },
        'users.lookupByEmail failed');
    } else {
      log.error({ accountId: opts.accountId, slackTeamId: opts.slackTeamId, err: (err as Error).message },
        'users.lookupByEmail unexpected error');
    }
    return null;
  }
}

/** Cache-only reverse lookup. Returns null on miss. */
export async function reverseResolveSlackIdentity(opts: {
  slackTeamId: string;
  slackUserId: string;
}): Promise<string | null> {
  const res = await withAdminScope(
    { caller: 'slack-identity-resolver', reason: 'reverse identity cache read' },
    (c) => c.query<{ account_id: string }>(
      `SELECT account_id FROM account_slack_identities
       WHERE slack_team_id = $1 AND slack_user_id = $2
       LIMIT 1`,
      [opts.slackTeamId, opts.slackUserId],
    ),
  );
  return res.rows[0]?.account_id ?? null;
}
