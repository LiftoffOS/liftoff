// Maps (connectorType, entityType) → entityId extracted from a trigger payload.
// Used by the pre-flight context injector before agent invocations.
//
// Two shape adapters are baked in:
//
//   1. inputData unwrapping. Event-triggered invocations enqueued from
//      src/scheduling/event-trigger.ts wrap the actual trigger data under
//      `inputData.eventData`:
//        { eventSource: 'google_mail',
//          eventEntityType: 'Email',
//          eventData: <raw trigger payload> }
//      Pre-fix this function received the outer object directly, so every
//      field lookup (`triggerPayload.threadId`, etc.) missed and the
//      pre-flight thread prefetch produced no context for any event-
//      triggered agent. Now we transparently descend into `eventData` when
//      present so the prefetch sees the real payload.
//
//   2. Composio snake_case. Composio's webhook payloads use snake_case
//      keys (`thread_id`, `conversation_id`, `channel_id`, `team_id`, …)
//      while older direct-vendor paths used camelCase. Each resolver below
//      checks the snake_case variant first and falls back to the camelCase
//      variant so both delivery paths produce the same entityId.

export function resolveEntityId(
  triggerPayload: Record<string, unknown>,
  connectorType: string,
  entityType: string,
): string | null {
  // Unwrap the event-trigger envelope when present so resolvers see the
  // actual webhook payload, not the dispatcher's wrapper.
  const eventData = (triggerPayload.eventData ?? triggerPayload) as Record<string, unknown>;

  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = eventData[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  };

  const resolvers: Record<string, Record<string, () => string | null>> = {
    slack: {
      thread: () => {
        const ch = pick('channel');
        const ts = pick('thread_ts', 'ts');
        return ch && ts ? `${ch}:${ts}` : null;
      },
    },
    zendesk:           { comments:      () => pick('ticket_id', 'ticketId', 'id') },
    atlassian_jira:    { comments:      () => pick('issue_id',  'issueId',  'key') },
    linear:            { comments:      () => pick('issue_id',  'issueId',  'id') },
    intercom:          { conversation:  () => pick('conversation_id', 'conversationId', 'id') },
    google_mail:       { thread:        () => pick('thread_id', 'threadId') },
    microsoft_outlook_mail: { conversation: () => pick('conversation_id', 'conversationId') },
    microsoft_teams: {
      messages: () => {
        const team = pick('team_id', 'teamId');
        const ch   = pick('channel_id', 'channelId');
        return team && ch ? `${team}:${ch}` : null;
      },
      thread: () => {
        const team = pick('team_id', 'teamId');
        const ch   = pick('channel_id', 'channelId');
        const msg  = pick('message_id', 'messageId');
        return team && ch && msg ? `${team}:${ch}:${msg}` : null;
      },
    },
    salesforce: { activity: () => pick('record_id', 'recordId', 'id') },
  };
  return resolvers[connectorType]?.[entityType]?.() ?? null;
}
