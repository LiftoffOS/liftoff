// Gmail overlay — Liftoff metadata atop Composio's vendor schemas.
// Hand-authored per the plan's C2 verbatim Gmail block.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

// Both naming conventions, for the same reason the send/reply inputs below
// carry both: the schema the AGENT is shown is the VENDOR one
// (src/schemas/gmail.ts, auto-generated from getRawComposioTools), so a model
// following it correctly sends `max_results` and `page_token` — names this
// translator did not read. It read only the canonical `limit`/`maxResults`/
// `pageToken`, so every advertised cap fell through to the `?? 50` default and
// every advertised cursor was dropped.
//
// A step that sends `{"user_id":"me","query":"from:...","max_results":25}`
// would get 50 messages — enough to exceed the step's 8,192 budget, so the run
// cannot park the result and goes to recovery, though the cap was in the step.
//
// `page_token` is the worse of the two: dropped silently, an agent paginating
// re-reads page one forever and cannot tell that it is looping.
interface GmailListInput {
  q?: unknown; query?: unknown;
  limit?: unknown; maxResults?: unknown; max_results?: unknown;
  pageToken?: unknown; page_token?: unknown;
  include_spam_trash?: unknown;
}
interface GmailListResp { messages?: Array<{ messageId?: string; id?: string; threadId: string; payload: unknown }>; nextPageToken?: string }
interface GmailModifyInput { threadId?: unknown; thread_id?: unknown; id?: unknown; }
// Tolerate both naming conventions:
//   - stable/Liftoff: { to, threadId, isHtml, body }
//   - Composio vendor names: { recipient_email, thread_id, is_html, body, message_body }
// The agent's exposed tool schema sometimes carries vendor names directly
// (when the schema is sourced from the Composio tool listing), so the
// overlay must not assume the stable-name form.
interface GmailSendInput {
  to?: unknown; recipient_email?: unknown;
  cc?: unknown; bcc?: unknown;
  subject?: unknown; body?: unknown;
  isHtml?: unknown; is_html?: unknown;
  threadId?: unknown; thread_id?: unknown;
}
interface GmailReplyInput {
  threadId?: unknown; thread_id?: unknown;
  body?: unknown; message_body?: unknown;
  isHtml?: unknown; is_html?: unknown;
}
interface GmailLabelMutInput { label_name?: unknown; name?: unknown; labelName?: unknown; label_id?: unknown; id?: unknown; labelId?: unknown; }
interface GmailMessageIdInput { messageId?: unknown; message_id?: unknown; id?: unknown; }
interface GmailReadThreadInput { id?: unknown; threadId?: unknown; thread_id?: unknown; }
interface GmailContactsResp { connections?: Array<{ resourceName?: string }>; nextPageToken?: string; results?: Array<{ person?: { resourceName?: string } }> }

/**
 * Resolve the reply recipient from the thread when the caller did not supply one.
 *
 * Reply tools do not ask the model for a recipient — replying to a thread
 * implies its participants — so the model never passes one. Composio then
 * refuses the call: "At least one of 'recipient_email', 'cc', or 'bcc' must be
 * provided". The address is not something the model should be guessing at
 * anyway; it is a fact about the thread.
 *
 * Walks the thread newest-to-oldest and takes the From of the first message this
 * mailbox did not send (Gmail marks self-originated mail SENT, and the agent's
 * own drafts DRAFT). That is the person being replied to.
 *
 * Returns args untouched when a recipient was supplied, when there is no
 * thread_id (cold outreach), or when the lookup fails — never fails the call.
 *
 * Shared by create_draft and reply_to_thread. In the first, an unresolved
 * recipient produces a draft with an empty To field. In reply_to_thread it is
 * worse: the vendor rejects the call outright, so the customer reply simply
 * does not send.
 */
const resolveThreadRecipient: NonNullable<ComposioToolOverlay['enrichBeforeExecute']> = async (args, ctx) => {
      const existingRecipient = args.recipient_email;
      if (typeof existingRecipient === 'string' && existingRecipient.length > 0) {
        return args;
      }
      const threadId = args.thread_id;
      if (typeof threadId !== 'string' || threadId.length === 0) {
        return args;
      }
      let thread: unknown;
      try {
        thread = await ctx.dispatchVendor('GMAIL_FETCH_MESSAGE_BY_THREAD_ID', {
          user_id: 'me',
          thread_id: threadId,
        });
      } catch {
        // Lookup failed — fall through with original args so the draft still
        // gets created, just with the empty To field the agent originally
        // produced. Don't fail the whole call.
        return args;
      }
      const messages =
        (thread as {
          messages?: Array<{
            payload?: { headers?: Array<{ name?: string; value?: string }> };
            labelIds?: string[];
          }>;
        }).messages ?? [];
      // Walk newest-to-oldest and pick the first message that wasn't sent by
      // this mailbox (label 'SENT' is Gmail's marker for self-originated
      // mail; 'DRAFT' for the agent's own drafts). That's the support
      // requester whose reply we're drafting.
      const reversed = [...messages].reverse();
      let fromHeaderValue: string | undefined;
      for (const m of reversed) {
        const labels = m.labelIds ?? [];
        if (labels.includes('SENT') || labels.includes('DRAFT')) continue;
        const fromHdr = (m.payload?.headers ?? []).find(
          (h) => h.name?.toLowerCase() === 'from',
        );
        if (fromHdr?.value) {
          fromHeaderValue = fromHdr.value;
          break;
        }
      }
      if (!fromHeaderValue) return args;
      // RFC 5322 From values look like `"Name" <addr@host>` or just
      // `addr@host`. Extract the angle-bracketed addr when present.
      const angle = /<([^>]+)>/.exec(fromHeaderValue);
      const email = angle ? angle[1].trim() : fromHeaderValue.trim();
      if (!email.includes('@')) return args;
      return { ...args, recipient_email: email };
};


/** One header value, case-insensitively, from a Gmail payload. */
function header(payload: unknown, name: string): string | undefined {
  const headers = (payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers ?? [];
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

/** First decoded text/plain body found anywhere in the MIME tree. */
function plainTextBody(payload: unknown, depth = 0): string | undefined {
  if (!payload || typeof payload !== 'object' || depth > 6) return undefined;
  const p = payload as {
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  };
  if (p.mimeType === 'text/plain' && p.body?.data) {
    try {
      return Buffer.from(p.body.data, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (!p.mimeType && p.body?.data) {
    try {
      return Buffer.from(p.body.data, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  for (const child of p.parts ?? []) {
    const found = plainTextBody(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** How much preview a LISTING carries per message. A listing exists to decide
 *  which message matters; the full body is what get_thread and read_message are
 *  for. */
const SNIPPET_LIMIT = 300;

/**
 * Project a raw Gmail message down to the fields an agent reasons about.
 *
 * The raw structure is base64 bodies, every MIME part, and the whole `Received:`
 * chain. Listing 25 messages could return hundreds of thousands of characters
 * to carry one short question. That result becomes the step's output, blows the
 * 8 KB step-output budget, is offloaded to a file in the run workspace, and the
 * next step then needs a tool call to read its own predecessor's value back —
 * which can lead an agent to ask a human for permission to run Python against
 * a file under /workspace/run-values/.
 */
function projectGmailMessage(m: { messageId?: string; id?: string; threadId?: string; payload?: unknown; snippet?: string }) {
  const body = plainTextBody(m.payload);
  const snippet = (m.snippet ?? body ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LIMIT);
  // Absent fields are omitted rather than set to undefined: the canonical shape
  // marks them optional, and an explicit undefined is noise in every consumer
  // that inspects the object.
  const out: Record<string, unknown> = {
    id: m.messageId ?? m.id ?? '',
    threadId: m.threadId ?? '',
  };
  const from = header(m.payload, 'From');
  const to = header(m.payload, 'To');
  const subject = header(m.payload, 'Subject');
  const date = header(m.payload, 'Date');
  if (from) out.from = from;
  if (to) out.to = to;
  if (subject) out.subject = subject;
  if (date) out.date = date;
  if (snippet) out.snippet = snippet;
  return out;
}


/** A READ of a message or thread carries the body, unlike a listing, which
 *  carries a snippet. Bounded so one pathological message cannot undo the
 *  projection; truncation is stated rather than silent. */
const BODY_LIMIT = 4000;

/** Attachment filenames, without any attachment CONTENT. Support mail routinely
 *  has them and whether one exists changes the answer; the bytes never do. */
function attachmentNames(payload: unknown, depth = 0, acc: string[] = []): string[] {
  if (!payload || typeof payload !== 'object' || depth > 6) return acc;
  const p = payload as { filename?: string; parts?: unknown[] };
  if (p.filename) acc.push(p.filename);
  for (const child of p.parts ?? []) attachmentNames(child, depth + 1, acc);
  return acc;
}

/**
 * Project a Gmail message for a READ — headers plus the decoded body.
 *
 * The raw form is base64 bodies, an HTML duplicate of every text part, and the
 * full `Received:` chain — typically tens of thousands of characters for
 * get_thread, read_thread and get_message alike. That is above the 8 KB
 * step-output budget on a typical call, so a step that reads a thread is
 * offloaded to a file and the next step has to fetch its own predecessor's
 * value back out of the workspace.
 *
 * Unlike the listing projection, this keeps the body: a read is where the agent
 * needs the words. What it drops is the transport — encoding, MIME structure and
 * routing headers — which is the overwhelming majority of the bytes and none of
 * the meaning.
 */
function projectGmailFullMessage(m: { id?: string; messageId?: string; threadId?: string; payload?: unknown }) {
  const raw = plainTextBody(m.payload) ?? '';
  const truncated = raw.length > BODY_LIMIT;
  const out: Record<string, unknown> = {
    id: m.messageId ?? m.id ?? '',
    threadId: m.threadId ?? '',
  };
  const from = header(m.payload, 'From');
  const to = header(m.payload, 'To');
  const subject = header(m.payload, 'Subject');
  const date = header(m.payload, 'Date');
  if (from) out.from = from;
  if (to) out.to = to;
  if (subject) out.subject = subject;
  if (date) out.date = date;
  if (raw) {
    out.body = truncated
      ? `${raw.slice(0, BODY_LIMIT)}\n\n[truncated — ${raw.length} characters total]`
      : raw;
  }
  const files = attachmentNames(m.payload).filter(Boolean);
  if (files.length) out.attachments = files;
  return out;
}

// Write-provenance declarations below are in CANONICAL shape: `idArgs` names the
// arguments the AGENT passes (what translateInput receives), and `returnsIds`
// paths are read against the canonical response (what translateOutput emits).
// Vendor-shape names would compile and match nothing.
export const GMAIL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GMAIL_FETCH_EMAILS: {
    stableName: 'list_messages',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      query: 'Gmail search query, exactly as typed in the Gmail search box (e.g. is:unread to:support@example.com). Omit to list everything.',
      max_results: 'How many messages to return (default 50).',
      page_token: 'The nextPageToken of a previous page, to continue listing.',
    },
    returnsIds: [{ entityType: 'message', path: 'items[].id' }, { entityType: 'thread', path: 'items[].threadId' }],
    categoryOverrides: ['read'],
    workRole: 'inbox',
    paired_ack: 'mark_as_read',
    workItemKind: 'email_message',
    translateInput: (a) => {
      const i = a as GmailListInput;
      return {
        user_id: 'me',
        query: i.q ?? i.query,
        max_results: i.limit ?? i.maxResults ?? i.max_results ?? 50,
        page_token: i.pageToken ?? i.page_token,
        include_spam_trash: i.include_spam_trash ?? false,
      };
    },
    translateOutput: (r) => {
      const resp = r as GmailListResp & { messages?: Array<{ snippet?: string }> };
      return {
        items: (resp.messages ?? []).map((m) => projectGmailMessage(m)),
        nextPageToken: resp.nextPageToken,
      };
    },
  },
  GMAIL_MODIFY_THREAD_LABELS: {
    // Exposed as the canonical 'mark_as_read' ack — overlay pre-fills
    // add_label_ids=[] and remove_label_ids=['UNREAD']; agent passes
    // only a thread id.
    stableName: 'mark_as_read',
    // user_id is always 'me'; the label ids ARE the ack and are pre-filled, so
    // the agent passes only the thread.
    overlayOwnedArgs: ['user_id', 'add_label_ids', 'remove_label_ids'],
    argDescriptions: {
      thread_id: 'The Gmail THREAD id (the threadId of a listed message), not a message id.',
    },
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'thread', path: 'id' }],
    categoryOverrides: ['write'],
    workRole: 'ack',
    acknowledges: 'list_messages',
    workItemKind: 'email_message',
    translateInput: (a) => {
      const i = a as GmailModifyInput;
      return {
        user_id: 'me',
        thread_id: i.threadId ?? i.thread_id ?? i.id,
        add_label_ids: [],
        remove_label_ids: ['UNREAD'],
      };
    },
    // Canonical shape for mark_as_read is { id, labelIds }.
    //
    // Composio's actual GMAIL_MODIFY_THREAD_LABELS response wraps the
    // modified Gmail thread inside `response_dict` (verified against
    // https://backend.composio.dev/api/v3/tools/GMAIL_MODIFY_THREAD_LABELS:
    // `output_parameters` schema is `{ data: { success, response_dict
    // (the Gmail Thread resource) } }`). The earlier translator read
    // `r.id` / `r.messages` at the top level and got nothing, so every
    // mark_as_read returned `{id: '', labelIds: []}`. The agent could not
    // tell whether UNREAD was actually removed and would keep
    // re-processing the same email on every list_messages cycle.
    // Surface `success: false` as an empty shape so the agent at least
    // sees no labels back when Composio reports the modify did not take
    // effect (vs the outer `successful: false` which the dispatcher
    // already throws on).
    translateOutput: (r) => {
      const wrapper = r as {
        success?: boolean;
        response_dict?: {
          id?: string; threadId?: string;
          messages?: Array<{ id: string; labelIds?: string[] }>;
        };
        id?: string; threadId?: string;
        messages?: Array<{ id: string; labelIds?: string[] }>;
      };
      if (wrapper.success === false) {
        return { id: '', labelIds: [] };
      }
      const thread = wrapper.response_dict ?? wrapper;
      const firstMsg = thread.messages?.[0];
      return {
        id: thread.id ?? thread.threadId ?? firstMsg?.id ?? '',
        labelIds: firstMsg?.labelIds ?? [],
      };
    },
  },
  GMAIL_SEND_EMAIL: {
    stableName: 'send_email',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      recipient_email: 'The To address (or comma-separated addresses).',
      body: 'The message body, plain text unless is_html is set.',
    },
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'message', path: 'id' }, { entityType: 'thread', path: 'threadId' }],
    categoryOverrides: ['write', 'outbound'],
    draftVariant: 'create_draft',
    descriptionSuffix:
      '\n\nIMPORTANT — pick exactly ONE of `send_email` or `reply_to_thread` ' +
      'per response. NEVER call both in the same step for the same message. ' +
      'Use `reply_to_thread` whenever you have a `thread_id` from a prior ' +
      'list/get call (this is the normal case for inbound support emails). ' +
      'Use `send_email` only when starting a brand-new outbound thread ' +
      '(cold outreach, no existing thread_id).',
    translateInput: (a) => {
      const i = a as GmailSendInput;
      return {
        user_id: 'me',
        recipient_email: i.recipient_email ?? i.to,
        cc: i.cc,
        bcc: i.bcc,
        subject: i.subject,
        body: i.body,
        is_html: i.is_html ?? i.isHtml ?? false,
        thread_id: i.thread_id ?? i.threadId,
      };
    },
    translateOutput: (r) => {
      const resp = r as { id?: string; threadId?: string };
      return { id: resp.id ?? '', threadId: resp.threadId ?? '' };
    },
  },
  // The second staged-write pair (ADR-052 rule 5), and the first on a connector
  // people live in: an email is DRAFTED by create_draft — Gmail holds it in the
  // person's own Drafts folder, where they can read exactly what would go out,
  // and no recipient sees anything — and COMMITTED by send_draft, one vendor
  // call Gmail sends whole or not at all. One approval covers the batch; the
  // runtime binds the person's yes to it by digest and lets send_draft apply it
  // exactly once. The provenance chain is native: create_draft RETURNS the
  // draft id, so the id send_draft names is always one this run has seen.
  // Declared as a pair or not at all; the registry validates the pairing at boot.
  GMAIL_CREATE_EMAIL_DRAFT: {
    stableName: 'create_draft',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      recipient_email: 'The To address (or comma-separated addresses).',
      body: 'The draft body, plain text unless is_html is set.',
    },
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'draft', path: 'id' }],
    categoryOverrides: ['write'],
    writeRole: 'stage',
    paired_apply: 'send_draft',
    translateInput: (a) => {
      const i = a as GmailSendInput;
      return {
        user_id: 'me',
        recipient_email: i.recipient_email ?? i.to,
        cc: i.cc,
        bcc: i.bcc,
        subject: i.subject,
        body: i.body,
        is_html: i.is_html ?? i.isHtml ?? false,
        thread_id: i.thread_id ?? i.threadId,
      };
    },
    translateOutput: (r) => {
      const resp = r as { id?: string; message?: unknown };
      return { id: resp.id ?? '', message: resp.message };
    },
    // When the agent calls `reply_to_thread` under `communication: 'draft'`,
    // the interceptor renames the call to `create_draft` but doesn't fill in
    // the recipient — the LLM never passed one because reply tools don't ask
    // for it. The resulting Gmail draft lands in the user's Drafts folder
    // with an empty To field. When `thread_id` is present and
    // `recipient_email` isn't, look the thread up via Composio and use the
    // From of the latest non-self message as the recipient. Returns args
    // unchanged when the agent already provided a recipient OR no
    // thread_id is available (cold-outreach drafts still work).
    enrichBeforeExecute: resolveThreadRecipient,
  },
  GMAIL_SEND_DRAFT: {
    stableName: 'send_draft',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      draft_id: 'The id of the existing draft to send (returned by create_draft).',
    },
    idArgs: ['draft_id'],
    categoryOverrides: ['write', 'outbound'],
    writeRole: 'apply',
    // No returnsIds: the response shape has not been observed, and a guessed
    // path reads as "declares nothing". The shape observer learns it from the
    // first real sends; a send is terminal for the staged batch either way.
    translateInput: (a) => {
      const i = a as { draft_id?: unknown; draftId?: unknown; user_id?: unknown };
      return {
        user_id: 'me',
        draft_id: i.draft_id ?? i.draftId,
      };
    },
  },
  GMAIL_REPLY_TO_THREAD: {
    stableName: 'reply_to_thread',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      thread_id: 'The Gmail THREAD id (the threadId of a listed message), not a message id.',
      message_body: 'The reply body, plain text unless is_html is set.',
    },
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'message', path: 'id' }, { entityType: 'thread', path: 'threadId' }],
    categoryOverrides: ['write', 'outbound'],
    draftVariant: 'create_draft',
    descriptionSuffix:
      '\n\nIMPORTANT — pick exactly ONE of `reply_to_thread` or `send_email` ' +
      'per response. NEVER call both in the same step for the same message. ' +
      'This is the right tool whenever you have a `thread_id` (normal case ' +
      'for inbound support emails). Use `send_email` only when starting a ' +
      'brand-new outbound thread with no existing thread_id.',
    translateInput: (a) => {
      const i = a as GmailReplyInput & { recipient_email?: unknown; to?: unknown; cc?: unknown; bcc?: unknown };
      return {
        user_id: 'me',
        thread_id: i.thread_id ?? i.threadId,
        message_body: i.message_body ?? i.body,
        is_html: i.is_html ?? i.isHtml ?? false,
        // Carried through rather than dropped. Composio refuses the call
        // without at least one of recipient_email / cc / bcc, and this mapping
        // used to discard all three — so a caller that DID supply a recipient
        // lost it here and the send failed anyway. resolveThreadRecipient fills
        // it in when it is still absent.
        recipient_email: i.recipient_email ?? i.to,
        cc: i.cc,
        bcc: i.bcc,
      };
    },
    enrichBeforeExecute: resolveThreadRecipient,
    translateOutput: (r) => {
      const resp = r as { id?: string; threadId?: string };
      return { id: resp.id ?? '', threadId: resp.threadId ?? '' };
    },
  },
  GMAIL_GET_PROFILE: {
    stableName: 'get_profile',
    overlayOwnedArgs: ['user_id'],
    categoryOverrides: ['read'],
    translateInput: () => ({ user_id: 'me' }),
  },
  GMAIL_LIST_LABELS: {
    stableName: 'list_labels',
    overlayOwnedArgs: ['user_id'],
    returnsIds: [{ entityType: 'label', path: 'items[].id' }],
    categoryOverrides: ['read'],
    translateInput: () => ({ user_id: 'me' }),
    translateOutput: (r) => {
      const resp = r as { labels?: Array<{ id: string; name: string }>; nextPageToken?: string };
      return { items: resp.labels ?? [], nextPageToken: resp.nextPageToken };
    },
  },
  GMAIL_LIST_THREADS: {
    stableName: 'list_threads',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      query: 'Gmail search query, exactly as typed in the Gmail search box. Omit to list everything.',
      max_results: 'How many threads to return.',
    },
    returnsIds: [{ entityType: 'thread', path: 'items[].id' }],
    categoryOverrides: ['read'],
    translateInput: (a) => {
      const i = a as GmailListInput;
      return {
        user_id: 'me',
        query: i.q ?? i.query,
        max_results: i.limit ?? i.maxResults ?? i.max_results ?? 50,
        page_token: i.pageToken ?? i.page_token,
      };
    },
    translateOutput: (r) => {
      const resp = r as { threads?: Array<{ id: string }>; nextPageToken?: string };
      return { items: resp.threads ?? [], nextPageToken: resp.nextPageToken };
    },
  },
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: {
    // History-tool: stable name is read_thread (see GMAIL_HISTORY_MAPPINGS),
    // but the same vendor tool also lives in the regular overlay map so it
    // appears in COMPOSIO_TOOL_OVERLAYS coverage. The merge step uses the
    // history mapping (which is canonical for history tools).
    stableName: 'get_thread',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      thread_id: 'The Gmail THREAD id (the threadId of a listed message), not a message id.',
    },
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'thread', path: 'id' }, { entityType: 'message', path: 'messages[].id' }],
    categoryOverrides: ['read'],
    translateInput: (a) => {
      const i = a as GmailReadThreadInput;
      return { user_id: 'me', thread_id: i.threadId ?? i.thread_id ?? i.id };
    },
    translateOutput: (r) => {
      const resp = r as { id?: string; messages?: Array<Record<string, unknown>> };
      return {
        id: resp.id ?? '',
        messages: (resp.messages ?? []).map((m) => projectGmailFullMessage(m)),
      };
    },
  },
  GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: {
    stableName: 'get_message',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      message_id: 'The Gmail MESSAGE id (the id of a listed message).',
    },
    idArgs: ['message_id'],
    returnsIds: [{ entityType: 'message', path: 'id' }, { entityType: 'thread', path: 'threadId' }],
    categoryOverrides: ['read'],
    translateInput: (a) => {
      const i = a as GmailMessageIdInput;
      return { user_id: 'me', message_id: i.messageId ?? i.message_id ?? i.id };
    },
    translateOutput: (r) => projectGmailFullMessage(
      r as { messageId?: string; id?: string; threadId?: string; payload?: unknown },
    ),
  },
  GMAIL_SEARCH_PEOPLE: {
    stableName: 'search_contacts',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      query: 'Name or address fragment to search contacts for.',
    },
    returnsIds: [{ entityType: 'contact', path: 'items[].resourceName' }],
    categoryOverrides: ['read'],
    translateInput: (a) => {
      const i = a as { query?: unknown; q?: unknown };
      return { user_id: 'me', query: i.query ?? i.q };
    },
    translateOutput: (r) => {
      const resp = r as GmailContactsResp;
      const items =
        (resp.connections ?? []).map((c) => ({ resourceName: c.resourceName ?? '' })) ||
        (resp.results ?? []).map((c) => ({ resourceName: c.person?.resourceName ?? '' }));
      return { items, nextPageToken: resp.nextPageToken };
    },
  },
  GMAIL_DELETE_MESSAGE: {
    stableName: 'delete_message',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      message_id: 'The Gmail MESSAGE id to delete permanently.',
    },
    idArgs: ['message_id'],
    categoryOverrides: ['write', 'destructive'],
    translateInput: (a) => {
      const i = a as GmailMessageIdInput;
      return { user_id: 'me', message_id: i.messageId ?? i.message_id ?? i.id };
    },
  },
  GMAIL_MOVE_TO_TRASH: {
    stableName: 'trash_message',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      message_id: 'The Gmail MESSAGE id to move to the trash.',
    },
    idArgs: ['message_id'],
    categoryOverrides: ['write'],
    translateInput: (a) => {
      const i = a as GmailMessageIdInput;
      return { user_id: 'me', message_id: i.messageId ?? i.message_id ?? i.id };
    },
  },
  GMAIL_CREATE_LABEL: {
    stableName: 'create_label',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      label_name: 'The name of the label to create.',
    },
    returnsIds: [{ entityType: 'label', path: 'id' }],
    categoryOverrides: ['write'],
    // The advertised name comes first; the aliases stay accepted, never
    // advertised.
    translateInput: (a) => {
      const i = a as GmailLabelMutInput;
      return { user_id: 'me', label_name: i.label_name ?? i.name ?? i.labelName };
    },
  },
  GMAIL_REMOVE_LABEL: {
    stableName: 'delete_label',
    overlayOwnedArgs: ['user_id'],
    argDescriptions: {
      label_id: 'The id of the label to delete (from list_labels), not its name.',
    },
    idArgs: ['label_id'],
    categoryOverrides: ['write', 'destructive'],
    translateInput: (a) => {
      const i = a as GmailLabelMutInput;
      return { user_id: 'me', label_id: i.label_id ?? i.id ?? i.labelId };
    },
  },
};

/** History-tool mappings — one per CONNECTORS[google_mail].historyReads
 *  entry. Boot validator hard-fails if any historyReads entry has no
 *  matching mapping. */
export const GMAIL_HISTORY_MAPPINGS: HistoryToolMapping[] = [
  {
    entityType: 'thread',
    stableName: 'read_thread',
    returnsIds: [
      { entityType: 'thread', path: 'id' },
      { entityType: 'message', path: 'messages[].id' },
    ],
    vendorToolName: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
    translateInput: (a) => {
      const i = a as GmailReadThreadInput;
      return { user_id: 'me', thread_id: i.threadId ?? i.thread_id ?? i.id };
    },
    translateOutput: (r) => {
      const resp = r as { messages?: Array<Record<string, unknown>> };
      return { items: (resp.messages ?? []).map((m) => projectGmailFullMessage(m)) };
    },
  },
];
