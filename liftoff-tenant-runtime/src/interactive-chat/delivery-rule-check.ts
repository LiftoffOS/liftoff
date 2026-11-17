// Are the delivery rules we state actually being followed?
//
// The chat system prompt already tells the agent how files reach a person: the
// document tools "create files and deliver them to the user as downloadable
// attachments", and prose names a document by filename and never by an id. Both
// are stated, neither is measured — so the failure mode where the agent instead
// writes out a path on the container's own disk, or a `file://` URL nobody can
// open, is invisible until a customer says "this link does not work".
//
// Two substrings, one counter. Not a filter: rewriting the agent's reply is a
// far bigger decision than knowing how often it needs rewriting, and shipping
// the measurement first is what tells us whether the filter is worth building.

import { incCounter } from '../memory/metrics';
import { logger } from '../infrastructure/logging';

export type DeliveryRule = 'file_url' | 'workspace_path';

/** Which stated delivery rules this text breaks. Pure; exported for testing and
 *  so the check reads the same in both halves. */
export function deliveryRuleViolations(
  text: string | undefined | null,
  /** The run's own workspace directory, e.g. /tmp/chat-threads/<tenant>/<thread>.
   *  Matched in full rather than by its root so a mention of the ROOT alone —
   *  which carries no tenant or thread — does not count. */
  workspacePath?: string,
): DeliveryRule[] {
  if (!text) return [];
  const found: DeliveryRule[] = [];
  // A file: URL resolves against the READER's machine, so it is never a link
  // the person can follow to something the agent produced.
  if (text.includes('file://')) found.push('file_url');
  // A path inside the run's container. It exists for minutes, on a machine the
  // person has no access to, and reads to them as somewhere they could look.
  if (workspacePath && text.includes(workspacePath)) found.push('workspace_path');
  return found;
}

/**
 * Count any violation on outbound chat text.
 *
 * Labels are the rule alone — no tenant or agent. incCounter keys its
 * in-process accumulator on the label set, so a per-tenant label would grow that
 * map for the life of the process; the ids go on the log line instead, which is
 * where anyone chasing a specific instance would look anyway.
 */
export function recordDeliveryRuleViolations(
  text: string | undefined | null,
  workspacePath: string | undefined,
  context: { tenantId: string; agentId: string; threadId: string; invocationId: string },
): void {
  for (const rule of deliveryRuleViolations(text, workspacePath)) {
    incCounter('chat_delivery_rule_violation_total', { rule });
    logger.warn(
      { event: 'chat_delivery_rule_violation', rule, ...context },
      'outbound chat text breaks a stated delivery rule',
    );
  }
}
