// What a run of failed polls means, and what to do about it.
//
// The poller is stateless per cycle: it cannot tell its first failure from its
// fiftieth, and "fifty in a row" is the fact worth acting on. Before this
// module the only thing that moved a connector out of `active` was an
// OAuthRefreshError from the credential refresher. A vendor that simply
// rejected the call raised nothing of the sort, so Gmail 401'd every minute for
// over an hour and the Connections page went on showing it Connected.
//
// THE CLASSIFICATION IS THE POINT. `active` → `error` is not a severity dial,
// it is a specific instruction to a person: the UI renders `error` as
// "Reconnect". Sending someone to redo an OAuth flow that cannot fix their
// problem is worse than showing nothing, because they do it, it does not help,
// and they stop trusting the signal. So a failure only earns that status when
// reconnecting is genuinely the remedy.
//
//   credential — the vendor rejected our authorization (401/403), or the
//                refresher gave up. A human reconnect is the fix. Counts toward
//                the threshold; at the threshold the connector flips.
//   code       — we never had a token to send (MissingBearerTokenError). A
//                reconnect CANNOT fix this; the client took a path it should
//                not have. Logged loudly with its own event so it can be
//                alerted on, and deliberately does NOT flip the status.
//   transient  — anything else: a 500, a timeout, a rate limit. Polling should
//                keep retrying and the status should not move.

import { OAuthRefreshError } from '../credentials/service.js';
import { MissingBearerTokenError } from '../clients/composio-transport.js';

export type PollFailureKind = 'credential' | 'code' | 'transient';

/** Consecutive credential-shaped failures before a connector is flipped to
 *  `error`. At the 60s base cycle this is five minutes of solid rejection —
 *  long enough that a redeploy or a brief vendor wobble does not park a
 *  working connector, short enough that a person is told the same session
 *  rather than the next day. */
export const AUTH_FAILURE_FLIP_THRESHOLD = 5;

/** Vendor responses that mean "your authorization is not good", as opposed to
 *  "something went wrong". Matched on the message because each client throws
 *  its own Error shape (`Gmail list failed: 401`, `Failed to search Apollo
 *  contacts (Status 401)`, …); the typed errors are checked first so prose
 *  matching is the fallback, not the contract. */
const CREDENTIAL_STATUS = /\b(401|403)\b|unauthorized|forbidden|invalid_grant|insufficient_scope/i;

export function classifyPollFailure(err: unknown): PollFailureKind {
  // A token we never had. Always a bug in the client, never the user's to fix.
  if (err instanceof MissingBearerTokenError) return 'code';
  // The refresher already decided the credential is unusable.
  if (err instanceof OAuthRefreshError) return 'credential';

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (CREDENTIAL_STATUS.test(message)) return 'credential';
  return 'transient';
}

/** Does this run of failures warrant taking the connector out of `active`?
 *
 *  Separated from the classifier so the threshold is testable on its own and
 *  the scheduler reads as a sentence. */
export function shouldFlipToError(kind: PollFailureKind, consecutiveFailures: number): boolean {
  return kind === 'credential' && consecutiveFailures >= AUTH_FAILURE_FLIP_THRESHOLD;
}

/** Which of two failures speaks for the connector this cycle.
 *
 *  A connector polls several entity types and they can fail differently. The
 *  order is not severity, it is who the failure belongs to: a `code` defect is
 *  ours and must never be reported to a customer as a credential problem, so it
 *  outranks everything. `credential` outranks `transient` because a real
 *  rejection is the more actionable of the two. */
const PRECEDENCE: Record<PollFailureKind, number> = { code: 2, credential: 1, transient: 0 };

export function worseFailure(a: PollFailureKind | null, b: PollFailureKind): PollFailureKind {
  if (a === null) return b;
  return PRECEDENCE[b] > PRECEDENCE[a] ? b : a;
}
