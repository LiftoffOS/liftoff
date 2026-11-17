// The shape a workflow's `{{input.<field>}}` / `$.input.<field>` references
// resolve against on an event-triggered run.
//
// WHY THIS EXISTS. `executeTask` receives `inputData` verbatim as the template
// root, and event-trigger.ts built it as:
//
//   { eventSource, eventEntityType, eventData: <raw connector payload> }
//
// while the distiller taught workflow authors `{{input.<field>}}` reads "the
// workflow input" and shipped a worked example using `{{input.thread_id}}`.
// Nothing reconciled the two. Every such reference missed, and because an
// unresolved placeholder used to render the four characters `null` rather than
// failing, the miss reached the vendor as a plausible value: a support agent
// would send Gmail `{"id":"null"}` and get back `400 Invalid id value`.
//
// The raw payload could not have been addressed correctly either. Composio's
// GMAIL_NEW_GMAIL_MESSAGE delivers flat snake_case (`thread_id`, `sender`,
// `label_ids`) while the native Gmail watch path delivers camelCase with the
// headers nested under `payload.headers[]`, so the SAME logical field has two
// spellings depending on which delivery path fired. A workflow cannot be
// written against that, and a validator cannot check it.
//
// The envelope is normalized here, once. WHAT it may contain is declared in
// `@liftoffos/runtime-shared-types` (workflow-event-input.ts) rather than here, because
// the control plane needs the identical answer to gate writes and to teach the
// distiller, and it cannot import this repo's modules. This file is the
// producer; that package is the contract.
//
// `eventData` is left on `inputData` untouched. Everything that reads it today
// (resolveEntityId's own unwrap, the objective string, screenUntrustedStructured)
// keeps working, and an author who genuinely needs a field this envelope does not
// carry can still reach it.

import type { EventMessageEnvelope } from '@liftoffos/runtime-shared-types';
import { resolveEntityId } from '../agent-execution/thread-id-resolver';

export type { EventMessageEnvelope };

/** Entity type to hand `resolveEntityId` for a given source. Its resolver map is
 *  keyed by the connector's own vocabulary ('thread', 'conversation',
 *  'comments'), which is not the `entityType` the event carries ('Email'). */
const RESOLVER_ENTITY_TYPE: Readonly<Record<string, string>> = {
  google_mail: 'thread',
  microsoft_outlook_mail: 'conversation',
  slack: 'thread',
  microsoft_teams: 'thread',
  zendesk: 'comments',
  atlassian_jira: 'comments',
  linear: 'comments',
  intercom: 'conversation',
  salesforce: 'activity',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pull a header out of the native Gmail `payload.headers[]` list. */
function nativeHeader(raw: Record<string, unknown>, name: string): string | null {
  const payload = raw.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined;
  if (!Array.isArray(payload?.headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of payload.headers) {
    if (typeof h?.name === 'string' && h.name.toLowerCase() === wanted && typeof h.value === 'string') {
      return h.value;
    }
  }
  return null;
}

/** Build the normalized envelope for one connector event.
 *
 *  `raw` is the connector payload as delivered (`data.payload.data`), NOT the
 *  outer inputData wrapper. Returns an envelope for every source: a source with
 *  no mail fields simply carries nulls for them, which is a truthful answer and
 *  keeps `{{input.message.id}}` addressable everywhere. */
export function buildEventMessageEnvelope(
  source: string,
  raw: Record<string, unknown> | undefined,
): EventMessageEnvelope {
  const payload = raw ?? {};

  // resolveEntityId unwraps an `eventData` key when present, so it is safe to
  // hand it the bare payload. Its per-connector key lists are the reason this
  // does not re-implement snake_case/camelCase matching here.
  const resolverEntity = RESOLVER_ENTITY_TYPE[source];
  const threadId = resolverEntity ? resolveEntityId(payload, source, resolverEntity) : null;

  const isMail = source === 'google_mail' || source === 'microsoft_outlook_mail';

  // Composio flat fields first, then the native shape. Composio is the primary
  // delivery source; native fields fill gaps for the watch/history
  // delivery path and for tests. (This precedence was set by the Gmail event
  // predicate that used to live in event-trigger.ts; the predicate is gone —
  // Gmail evaluates its own query language now — but the ordering outlived it.)
  const outlookFrom = (payload.from as { emailAddress?: { address?: string } } | undefined)
    ?.emailAddress?.address;
  const outlookTo = (payload.toRecipients as Array<{ emailAddress?: { address?: string } }> | undefined)
    ?.map((r) => r?.emailAddress?.address)
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .join(', ');

  const rawLabels = payload.label_ids ?? payload.labelIds ?? payload.categories;
  const labels = Array.isArray(rawLabels)
    ? rawLabels.filter((l): l is string => typeof l === 'string')
    : [];

  const attachmentList = payload.attachment_list;
  const nativeParts = (payload.payload as { parts?: Array<{ filename?: string; body?: { attachmentId?: string } }> } | undefined)?.parts ?? [];

  return {
    id: str(payload.id) ?? str(payload.message_id) ?? str(payload.messageId) ?? str(payload.ts),
    threadId,
    // `from` and `text` carry a THIRD spelling, because this envelope now has a
    // third producer.
    //
    // It was written for two: Composio's trigger payload (`sender`,
    // `message_text`) and the native watch/history shape (nested headers). A
    // companion routine's work source feeds it a CANONICAL LIST ITEM instead —
    // what `list_messages` returns after the overlay projects it — and that
    // spells the same two fields `from` and `snippet`.
    //
    // Without this branch the sweep resolves an unread thread, builds an
    // envelope with a correct id and threadId and a NULL sender and body, and
    // the agent tells the customer so — then escalates a message it could read
    // perfectly well over IMAP.
    //
    // `str()` returns null for anything that is not a non-empty string, so the
    // Outlook `from` object cannot leak in through this branch; outlookFrom is
    // tried first and destructures it properly.
    from: isMail
      ? str(payload.sender) ?? str(outlookFrom) ?? str(payload.from) ?? nativeHeader(payload, 'From')
      : null,
    to: isMail
      ? str(payload.to) ?? str(outlookTo) ?? nativeHeader(payload, 'To')
      : null,
    subject: isMail
      ? str(payload.subject) ?? nativeHeader(payload, 'Subject')
      : null,
    labels: isMail ? labels : [],
    hasAttachment: isMail
      ? (Array.isArray(attachmentList) && attachmentList.length > 0)
        || nativeParts.some((p) => (p?.filename && p.filename.length > 0) || Boolean(p?.body?.attachmentId))
      : false,
    text: isMail
      ? str(payload.message_text) ?? str(payload.bodyPreview) ?? str(payload.body) ?? str(payload.snippet)
      : null,
  };
}
