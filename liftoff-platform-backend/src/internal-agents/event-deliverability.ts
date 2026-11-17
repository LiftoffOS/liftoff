// Can a bound connector actually deliver an event to an agent?
//
// One predicate, imported by both halves, because the two halves disagreeing is
// not a cosmetic inconsistency — it makes a redistill IMPOSSIBLE to satisfy.
//
// The prompt half (`buildEventTopicsText`) tells the model which topics exist.
// The enforcing half (trigger-config-analyzer Rule 6) rejects a cron trigger
// when a topic exists. They keyed on different fields:
//
//   prompt half   → eventTrigger !== undefined   (19 polling rows)
//   analyzer half → listImplemented === true     (87 polling rows)
//
// So for the 68 rows in between — GitHub's PullRequest among them — the model
// was told "EVENT TOPICS — none of the connected integrations can deliver an
// event" while the analyzer rejected its cron trigger and demanded it "copy one
// topic VERBATIM" from that empty list. Three retries, then a 500. The agent
// could not be redistilled at all, and the failure looked like a bad agent
// rather than a contradiction in the platform. An agent whose responsibilities
// happen to say "every 5 minutes" escaped only because that trips the
// explicit-cron-intent escape and skips Rule 6 entirely. Nothing about that is
// by design.
//
// `eventTrigger` is the correct axis. It carries a real Composio trigger slug
// (GMAIL_NEW_GMAIL_MESSAGE, JIRA_NEW_ISSUE_TRIGGER) — the thing that actually
// fires. `listImplemented` says the list/poll METHOD is implemented, which is a
// different question, and the two are independent in both directions:
//
//   listImplemented: true,  no eventTrigger   → advertised, never delivered
//   listImplemented: false, eventTrigger set  → deliverable, never offered
//
// Confluence is the second case in the live catalog, so this is not theoretical.

// TWO WAYS TO PUT AN EVENT ON THE WIRE, AND THIS KNEW ONLY ONE.
//
// `eventTrigger` carries a COMPOSIO slug, so a connector that delivers through
// its OWN webhook had no way to say so and was read as unable to deliver at all.
// The distiller then turns reactive responsibilities into cron polling, and
// invents a safety property to make polling sound — for a code reviewer,
// head-SHA dedupe. That invented property does not hold: a polling reviewer
// can post several bot reviews of one pull request at one head SHA.
//
// Slack is the sharper case. Its eventTrigger was removed with the Composio
// revert because the slug cannot fire without a Composio account, while it kept
// delivering natively through the Events API webhook. Removing the slug removed
// its ability to say it is reactive, so every Slack agent distilled without
// this is given cron polling for a connector that pushes. Nothing reports it,
// because polling works — just late, and at every-minute cost.

/** True when this polling row can actually put an event on the wire.
 *
 *  Either mechanism counts: a Composio trigger slug, or the connector's own
 *  webhook publishing onto connector-events. The distiller only needs to know
 *  that SOMETHING will fire, not which of the two does it. */
export function deliversEvents(
  polling: { eventTrigger?: unknown; nativeEventDelivery?: boolean },
): boolean {
  return polling.eventTrigger !== undefined || polling.nativeEventDelivery === true;
}
