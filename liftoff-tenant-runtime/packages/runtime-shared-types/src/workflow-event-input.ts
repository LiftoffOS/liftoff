/**
 * What `input` carries on an event-triggered workflow run, and which
 * `{{input.<field>}}` / `$.input.<field>` references can resolve against it.
 *
 * CANONICAL. Three places need to agree about this and previously did not:
 *
 *   - the Tenant Runtime BUILDS the object (`scheduling/event-input-envelope.ts`)
 *   - the Tenant Runtime VALIDATES references against it before a run
 *   - the control plane REFUSES to store a workflow whose references cannot
 *     resolve, and TEACHES the distiller which fields exist
 *
 * The control plane cannot import the runtime's modules, so before this file
 * existed the field list was a literal in each service with a comment naming
 * the other. That is the same arrangement that produced the defect it guards
 * against: the distiller taught `{{input.thread_id}}`, the runtime supplied
 * `{eventSource, eventEntityType, eventData}`, nothing compared them, and an
 * unresolved placeholder could render the four characters `null` into a Gmail
 * message id.
 *
 * Both the DATA and the RULE live here. Sharing the list while each service
 * re-implemented "is this path addressable" would leave the two able to
 * disagree about prefixes, about the raw-payload escape hatch, and about what
 * to do with a connector nobody has normalized — which is most of the
 * semantics.
 */

/** The normalized entity an event-triggered run was woken by.
 *
 *  Every field is nullable on purpose: a connector that does not carry one is a
 *  fact to be represented, not a reason to invent a value. */
export interface EventMessageEnvelope {
  /** The entity's own id — a Gmail message id, a Slack message ts, an issue id. */
  id: string | null;
  /** The conversation this entity belongs to, when the source has that concept. */
  threadId: string | null;
  /** Mail-shaped sources only. */
  from: string | null;
  to: string | null;
  subject: string | null;
  /** Mail-shaped sources only. An ARRAY, never a Set: a Set serializes to `{}`
   *  through the template layer and reads as empty to the condition evaluator. */
  labels: string[];
  hasAttachment: boolean;
  /** The body text where the payload carries it inline. */
  text: string | null;
}

/** Roots addressable directly under `input` on an event-triggered run. */
export const EVENT_INPUT_ROOT_FIELDS: readonly string[] = [
  'eventSource',
  'eventEntityType',
  'eventData',
  'message',
];

/** Sources whose payload carries an entity id but no conversation the runtime
 *  can resolve. Advertising `message.threadId` for one of these would be the
 *  defect this file exists to prevent, one level up: a validator would bless
 *  `{{input.message.threadId}}`, the producer would emit null, and the step
 *  would fail at run time with the reference having passed every check. */
const ID_ONLY_FIELDS = ['message.id'] as const;

const IDENTITY_FIELDS = ['message.id', 'message.threadId'] as const;
const MAIL_FIELDS = [
  'message.id',
  'message.threadId',
  'message.from',
  'message.to',
  'message.subject',
  'message.labels',
  'message.hasAttachment',
  'message.text',
] as const;

/** Addressable `message.*` paths per connector source.
 *
 *  A source absent from this map is one nobody has normalized. Its raw payload
 *  is still reachable at `input.eventData.*`; what must NOT happen is a
 *  validator inventing a verdict about fields it cannot know. */
export const EVENT_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  google_mail: MAIL_FIELDS,
  microsoft_outlook_mail: MAIL_FIELDS,
  slack: IDENTITY_FIELDS,
  microsoft_teams: IDENTITY_FIELDS,
  // No thread resolver exists for GitHub — its events are pull requests and
  // issues, which the runtime addresses by their own id, so `message.threadId`
  // would always be null.
  github: ID_ONLY_FIELDS,
  zendesk: IDENTITY_FIELDS,
  atlassian_jira: IDENTITY_FIELDS,
  linear: IDENTITY_FIELDS,
  intercom: IDENTITY_FIELDS,
  salesforce: IDENTITY_FIELDS,
};

/**
 * Is `path` — everything after `input.` — addressable for these event sources?
 *
 * `eventSources` is a LIST because only the executing run knows its source
 * exactly. The pre-flight audit and the control plane's write-time gate know
 * only which connectors an agent is bound to, and `email.received` is reachable
 * from both Gmail and Outlook (the topic→connector map is served by the
 * connector service's catalog at run time, so no static check can resolve it).
 * Resolving against the union is the honest reading: a field absent from EVERY
 * candidate cannot appear whichever one fires, and that is the case worth
 * blocking. A field present in one of them is not something a static check may
 * call wrong.
 *
 * Returns true whenever the answer is not knowable, because a check that
 * refuses what it merely cannot see blocks valid workflows.
 */
export function eventInputPathResolvable(path: string, eventSources: readonly string[]): boolean {
  const known = eventSources.filter((s) => EVENT_INPUT_FIELDS[s]);
  if (known.length === 0) return true;
  const root = path.split('.')[0];
  if (!EVENT_INPUT_ROOT_FIELDS.includes(root)) return false;
  // The raw payload is the author's responsibility: its shape is the
  // connector's, and neither service can know it.
  if (root !== 'message') return true;
  // A prefix of a known field counts — a template may pass the whole `message`
  // object, and `message` is legitimate exactly when `message.id` is.
  return known.some((source) =>
    EVENT_INPUT_FIELDS[source].some((f) => f === path || f.startsWith(`${path}.`)));
}

/** The union of fields the given sources supply, for an actionable error
 *  message that tells the author what to write instead. */
export function addressableEventInputFields(eventSources: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const source of eventSources) {
    for (const f of EVENT_INPUT_FIELDS[source] ?? []) seen.add(f);
  }
  return [...seen];
}
