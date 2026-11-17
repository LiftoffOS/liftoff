// Telling somebody the Chief AI Officer answered them while they were away.
//
// The other three chat surfaces do this in platform-backend, one call away from
// their persist point. The team plan cannot: migration 131 moved its threads
// and messages into THIS database, so the service that knows a reply landed is
// not the service that holds the notification preferences, the push tokens, or
// the opaque-link table. It asks, exactly as the facepile asks for account
// names next door.
//
// Presence stays on this side, because team-plan seats are in this database
// too. Sending the call only when the person is away also means the common case
// — somebody sitting on the thread watching the answer stream in — costs no
// cross-service request at all.

import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { log } from '../infrastructure/logging.js';
import { isAccountPresent } from './presence-repository.js';
import type { CallerVia } from './caller-context.js';

// Matches the internal route's own cap. Trimmed again by the push builder into
// what a notification can actually show.
const MAX_TEXT = 4000;

/**
 * Tell the person who asked that their answer landed, unless they are sitting
 * on the thread watching it arrive.
 *
 * Best-effort and never throws: the reply is committed before this runs, so
 * nothing here can cost somebody their message.
 */
export async function notifyTeamPlanReply(params: {
  tenantId: string;
  accountId: string;
  threadId: string;
  text: string;
  /** Where the turn came through. A turn from a Slack or Teams workspace is
   *  answered there by the surface that ran it, so nobody is told again. */
  via?: CallerVia | null;
}): Promise<void> {
  const { tenantId, accountId, threadId, via } = params;
  try {
    if (via === 'slack' || via === 'teams') return;
    // Watching the message arrive is the same as having been told.
    if (await isAccountPresent(tenantId, threadId, accountId)) return;

    const text = params.text.slice(0, MAX_TEXT);
    if (text.length === 0) return;

    const config = loadConfig();
    const baseUrl = config.PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const headers = await getServiceAuthHeaders(baseUrl, config.WORKFORCE_SERVICE_TOKEN);
    const response = await fetch(`${baseUrl}/api/internal/chat-notify/team-plan-reply`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, accountId, threadId, text, via: via ?? null }),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, threadId },
        'team plan reply notification rejected - nobody was told the answer arrived',
      );
    }
  } catch (err) {
    log.warn(
      { threadId, error: (err as Error).message },
      'team plan reply notification threw - nobody was told the answer arrived',
    );
  }
}
