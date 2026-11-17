// Resolve an inbound Microsoft Teams user → Liftoff account.
//
// The inbound Activity already identifies who is talking. We read their profile
// (name + email) from the Bot Framework roster (TeamsInfo.getMember, backed by
// the bot's own credentials — no Graph call, no Graph consent needed) and match
// the email to an accounts row. Like the Slack adapter this is NON-GATING: users
// without a Liftoff account are "guests" and the agent still responds.

import { TeamsInfo, type TurnContext } from 'botbuilder';
import { getPool } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';

export interface ResolvedTeamsUser {
  userId: string;          // account id, or `teams:<id>` for guests
  accountId: string | null; // null when no Liftoff account matches
  /** Greeting-safe. Falls back to 'there' so the agent can say "Hi there"
   *  rather than "Hi 29:1abc…". NOT an identity — do not attribute with it. */
  displayName: string;
  /** Attribution-grade identity, mirroring the Slack adapter's chain
   *  (roster name → activity name → raw channel id). Never a greeting word,
   *  so a guest message always renders as *someone* rather than anonymously. */
  identityLabel: string;
}

async function matchAccountByEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  try {
    const res = await getPool().query<{ id: string }>(
      'SELECT id FROM accounts WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'accounts email match failed');
    return null;
  }
}

/**
 * Resolve the Teams user for the current turn from the conversation roster.
 * `fromId` is the Activity's from.id (the Teams channel-account id).
 */
export async function resolveTeamsUser(
  ctx: TurnContext,
  fromId: string,
  fallbackName?: string,
): Promise<ResolvedTeamsUser> {
  let email: string | null = null;
  let rosterName: string | null = null;

  try {
    const member = await TeamsInfo.getMember(ctx, fromId);
    email = member.email || member.userPrincipalName || null;
    if (member.name) rosterName = member.name;
  } catch (err) {
    log.info({ fromId, err: (err as Error).message }, 'TeamsInfo.getMember failed — treating as guest');
  }

  const accountId = await matchAccountByEmail(email);
  const fallbackId = (ctx.activity.from?.aadObjectId as string | undefined) ?? fromId;

  // Two names, because the two consumers want different things. The greeting
  // wants something friendly and tolerates a placeholder; attribution wants
  // something that identifies a specific person and tolerates ugliness. Slack
  // gets away with one field only because its last resort (the raw user id)
  // happens to serve both badly-but-acceptably.
  const identityLabel =
    rosterName || fallbackName?.trim() || `teams:${fallbackId}`;

  return {
    userId: accountId ?? `teams:${fallbackId}`,
    accountId,
    displayName: rosterName || fallbackName || 'there',
    identityLabel,
  };
}
