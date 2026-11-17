// Carrying the provisioning notice back into the Liftoff conversation.
//
// A person can reach the Chief AI Officer two ways: the team-plan surface
// directly, or the Liftoff composer on the dashboard home, which BRINGS the CAIO
// in and pairs the Liftoff thread with a team-plan thread. In the second case
// the person never opens the team-plan thread at all: they read one conversation
// with two voices in it, because Liftoff copies the CAIO's replies across as it
// streams them.
//
// That copy only happens while the Liftoff turn is running. The provisioning
// notice arrives minutes after it ended, so posting it to the team-plan thread
// alone would file it in a conversation the person has never seen. The dev
// report that prompted this module was exactly that shape: liftoff thread
// 1f6c871a, paired with CAIO thread f411a323.
//
// platform-backend owns `liftoff_thread_delegations` in its own database, so the
// pairing cannot be resolved from here. It already has the machinery, built for
// the HITL resume: mirrorDelegatedReplyToLiftoff, which attributes the copy with
// the same author/author_label columns the live path uses. This is the wire to
// it. That module's header used to say the CAIO has no continuation to carry
// back, because it has no approval gate; background provisioning is the case
// that assumption missed.
//
// Best-effort by contract. The notice is already in the team-plan thread before
// this runs, and a workspace that never used Liftoff has no pairing to find, so
// "no mirror" is the ordinary outcome rather than an error.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';

/**
 * Ask platform-backend to copy a CAIO notice into the Liftoff conversation
 * paired with this team-plan thread.
 *
 * Returns true only when a copy was actually written, which is the signal worth
 * logging: false covers both "this thread is not paired" and "the call failed",
 * and neither is actionable here.
 */
export async function mirrorNoticeToLiftoff(input: {
  tenantId: string;
  /** The CAIO's own thread, which is what the pairing is keyed on. */
  delegateThreadId: string;
  content: string;
}): Promise<boolean> {
  try {
    const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const url = `${baseUrl}/api/internal/liftoff/mirror-caio-notice`;
    const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);

    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: input.tenantId,
        delegateThreadId: input.delegateThreadId,
        content: input.content,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from platform-backend /api/internal/liftoff/mirror-caio-notice`);
    }

    const body = (await res.json()) as { mirrored?: boolean };
    if (body.mirrored) {
      log.info(
        { event: 'provisioning_notice_mirrored', tenantId: input.tenantId, delegateThreadId: input.delegateThreadId },
        'Provisioning notice mirrored into the Liftoff conversation that asked for the plan',
      );
    }
    return body.mirrored === true;
  } catch (err) {
    log.warn(
      {
        event: 'provisioning_notice_mirror_failed',
        tenantId: input.tenantId,
        delegateThreadId: input.delegateThreadId,
        error: (err as Error).message,
      },
      'Could not mirror the provisioning notice into Liftoff — it is still in the plan thread',
    );
    return false;
  }
}
