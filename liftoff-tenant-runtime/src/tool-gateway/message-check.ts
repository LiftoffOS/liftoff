// The Communication setting reads the message.
//
// Two of the three modes on /dashboard/oversight promise a judgment about
// content that the code never made: "Send automatically when safe" sent
// everything, and "Review for sensitive cases" paused on the TOOL's
// categories without reading the message. This is that judgment, at the
// execute-time wrapper on both paths (the LLM catalog's handler in
// mcp-server.ts and the sandbox dispatch), only for an outbound tool, only
// under `auto` or `review`, and under `review` only when the tool matched a
// ticked category (the case that pauses today). "Draft first" is untouched.
//
// One Noul per ticked Sensitive Work key, keyed by the setting's own key,
// with the criterion written as the category's definition on the page. Two
// bands: UNSAFE_T (to add a pause under Auto) sits well above CLEAR_T (to
// remove one under Review), so the same answers are never both "unsafe
// enough to pause" under one setting and "clear enough to send" under the
// other; between them the setting's own default applies.
//
// Completeness is a precondition of clearing. The content is the tool's
// outgoing fields as they will be sent — body, subject, attachment names,
// destination — with secrets redacted and nothing else cut. A state over
// MESSAGE_STATE_BYTES, or a message with no body field, is incomplete: not
// sent under Review (today's pause, `context.messageCheck.incomplete`), not
// paused under Auto (today's send). Under Review a send is cleared only when
// every asked Noul answered at or below CLEAR_T, the state was complete, and
// the workspace saved its Communication setting under the stated meaning
// (`communicationSemantics >= 2`). Every verdict is recorded: on the
// approval's `context.messageCheck` when a pause is created, on the audit
// line `hitl.gate.message_cleared` when a Review message goes out.

import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import { asEntry, messageCheckSet, MESSAGE_CHECK_NOULS, MESSAGE_STATE_BYTES } from '../typesafe/questions';
import { isMessageCheckEnabled } from '../typesafe/flags';
import { redactString } from '../security/log-redactor';
import { boundedContract, type HitlContract } from '../hitl-enforcement/contract-check';
import type { OversightSettings } from '../hitl-enforcement/types';
import { isOutboundTool, type OversightFilterDecision } from './oversight-decision';

export interface MessageCheckInput {
  toolName: string;
  categories: string[];
  args: Record<string, unknown>;
  oversight: OversightSettings | undefined;
  /** The catalog decision for this tool under this oversight
   *  (`oversightDecisionFor`): under Review the check runs only on
   *  `require_approval` with reason `sensitive_work`. */
  decision: OversightFilterDecision;
  contract?: HitlContract;
  tenantId: string;
  /** The RUNTIME agent id. */
  agentId?: string;
  invocationId?: string;
}

/** What the record carries, cleared or not. */
export interface MessageCheckRecord {
  setting: 'auto' | 'review';
  asked: Record<string, number>;
  model?: string;
  latencyMs?: number;
  incomplete?: boolean;
}

export type MessageCheckOutcome =
  /** No call, or a verdict that leaves the setting's own default in place. */
  | { kind: 'as_today'; context?: { messageCheck: MessageCheckRecord } }
  /** Auto: an asked Noul at or above UNSAFE_T; the message pauses. */
  | { kind: 'pause'; reason: 'sensitive_work'; matchedCategory: string; context: { messageCheck: MessageCheckRecord } }
  /** Review: every asked Noul at or below CLEAR_T on a complete state; sends. */
  | { kind: 'send'; context: { messageCheck: MessageCheckRecord } };

/** The whole call's budget. */
export const MESSAGE_CHECK_DEADLINE_MS = 30_000;

const BODY_KEYS = ['body', 'text', 'message', 'content', 'html', 'htmlBody', 'html_body', 'comment', 'description', 'caption', 'post', 'note'];
const SUBJECT_KEYS = ['subject', 'title'];
const ATTACHMENT_KEYS = ['attachments', 'files', 'media'];
const DESTINATION_KEYS: Readonly<Record<string, string>> = {
  to: 'recipients', cc: 'recipients', bcc: 'recipients', recipients: 'recipients', recipient: 'recipients',
  email: 'recipients', emails: 'recipients', phone: 'recipients', number: 'recipients', user: 'recipients',
  userId: 'recipients', user_id: 'recipients',
  channel: 'channel', channel_id: 'channel', channelId: 'channel', chatId: 'channel', chat_id: 'channel',
  conversationId: 'channel', conversation_id: 'channel', groupId: 'channel',
  thread_ts: 'thread', thread_id: 'thread', threadId: 'thread', threadTs: 'thread', ts: 'thread',
  url: 'url', link: 'url', webhookUrl: 'url', pageId: 'url', page_id: 'url',
};

function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x);
    return out;
  }
  return v;
}

function attachmentNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>;
      const n = o.name ?? o.filename ?? o.fileName ?? o.title;
      return typeof n === 'string' ? n : '';
    }
    return '';
  }).filter(Boolean);
}

export interface OutgoingMessage {
  content: Record<string, unknown>;
  destination: Record<string, unknown>;
  /** A body field was found: the one field every outbound tool family has. */
  complete: boolean;
}

/** The tool's outgoing fields as they will be sent, by field name across the
 *  families `isOutboundTool` classifies: the body, the subject, attachment
 *  names, and the destination. Secrets redacted; nothing cut. Exported for
 *  the test. */
export function outgoingMessageOf(args: Record<string, unknown>): OutgoingMessage {
  const content: Record<string, unknown> = {};
  const destination: Record<string, unknown> = {};
  let complete = false;
  const visit = (obj: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;
      if (BODY_KEYS.includes(key) && (typeof value === 'string' || Array.isArray(value) || typeof value === 'object')) {
        if (content.body === undefined) {
          content.body = redactDeep(value);
          complete = true;
        }
        continue;
      }
      if (SUBJECT_KEYS.includes(key) && typeof value === 'string') {
        if (content.subject === undefined) content.subject = redactString(value);
        continue;
      }
      if (ATTACHMENT_KEYS.includes(key)) {
        const names = attachmentNames(value);
        if (names.length) content.attachments = [...((content.attachments as string[] | undefined) ?? []), ...names.map(redactString)];
        continue;
      }
      const dest = DESTINATION_KEYS[key];
      if (dest && (typeof value === 'string' || typeof value === 'number' || Array.isArray(value))) {
        const prior = destination[dest];
        const next = redactDeep(value);
        destination[dest] = prior === undefined ? next : [prior, next].flat();
        continue;
      }
      if (depth < 2 && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, depth + 1);
      }
    }
  };
  visit(args, 0);
  return { content, destination, complete };
}

/** Who reads it, from the tool's categories. */
export function audienceOf(categories: string[]): 'external' | 'internal' | 'unknown' {
  if (categories.includes('customerCommunication') || categories.includes('externalPublishing')) return 'external';
  if (categories.includes('internalCollaboration')) return 'internal';
  return 'unknown';
}

/** The ticked keys this check asks about: the settings' enabled keys the
 *  table names. `mergeToMain` and any future key are never asked. */
export function tickedKeysOf(oversight: OversightSettings | undefined): string[] {
  const enabled = (oversight?.sensitiveWork ?? {}) as Record<string, boolean | undefined>;
  return Object.keys(MESSAGE_CHECK_NOULS).filter((key) => enabled[key] === true);
}

export async function checkMessage(input: MessageCheckInput): Promise<MessageCheckOutcome> {
  const asToday: MessageCheckOutcome = { kind: 'as_today' };
  if (!isMessageCheckEnabled()) return asToday;
  if (!isOutboundTool({ categories: input.categories })) return asToday;
  const setting = input.oversight?.communication;
  if (setting !== 'auto' && setting !== 'review') return asToday;
  if (setting === 'review' && !(input.decision.kind === 'require_approval' && input.decision.reason === 'sensitive_work')) return asToday;
  const ticked = tickedKeysOf(input.oversight);
  if (ticked.length === 0) return asToday;

  const log = {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    invocation_id: input.invocationId,
    tool_name: input.toolName,
    setting,
  };
  const set = messageCheckSet(ticked);
  const message = outgoingMessageOf(input.args);
  const state = {
    message: { tool: input.toolName, content: message.content, destination: message.destination },
    audience: audienceOf(input.categories),
    ticked,
    contract: input.contract ? boundedContract(input.contract) : null,
  };
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (!message.complete || bytes > MESSAGE_STATE_BYTES) {
    // An incomplete payload can never clear a pause: the commitment or
    // disclosure being judged may be in the part left out. Under Review
    // today's pause, marked; under Auto today's send, logged so the bound
    // can be revisited.
    const record: MessageCheckRecord = { setting, asked: {}, incomplete: true };
    logger.warn({ ...log, metric: 'message_check.incomplete', bytes, bound: MESSAGE_STATE_BYTES, body_present: message.complete },
      setting === 'review'
        ? 'message check: the outgoing message is incomplete for the check; pausing as today'
        : 'message check: the outgoing message is incomplete for the check; sending as today');
    return { kind: 'as_today', context: { messageCheck: record } };
  }

  const answer = await ask(set, asEntry(state), {
    deadlineMs: MESSAGE_CHECK_DEADLINE_MS,
    tenantId: input.tenantId,
    ...(input.agentId ? { runtimeAgentId: input.agentId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
  });
  if (!answer) return asToday;

  const asked: Record<string, number> = {};
  let missing = false;
  for (const key of ticked) {
    const noul = MESSAGE_CHECK_NOULS[key].noul;
    const head = (answer.answers as Record<string, { noul?: number } | undefined>)[noul];
    if (typeof head?.noul !== 'number') { missing = true; continue; }
    asked[key] = head.noul;
  }
  const record: MessageCheckRecord = { setting, asked, model: answer.model, latencyMs: answer.latencyMs };
  const unsafeT = set.thresholds.UNSAFE_T as number;
  const clearT = set.thresholds.CLEAR_T as number;

  if (setting === 'auto') {
    // This direction only adds pauses, where the label promised a check.
    const unsafe = Object.entries(asked).filter(([, p]) => p >= unsafeT).sort((a, b) => b[1] - a[1])[0];
    if (!unsafe) return { kind: 'as_today', context: { messageCheck: record } };
    logger.info({ ...log, metric: 'message_check.unsafe', category: unsafe[0], probability: unsafe[1], call_id: answer.callId },
      'message check: the message is not safe to send automatically; pausing for a person');
    return { kind: 'pause', reason: 'sensitive_work', matchedCategory: unsafe[0], context: { messageCheck: record } };
  }

  // Review: the loosening direction, and only by the person's own setting,
  // re-saved after the change.
  const semantics = input.oversight?.communicationSemantics ?? 1;
  const allClear = !missing && ticked.every((key) => asked[key] !== undefined && asked[key] <= clearT);
  if (semantics >= 2 && allClear) {
    logger.info({ ...log, event: 'hitl.gate.message_cleared', metric: 'hitl.gate.message_cleared', ...record, call_id: answer.callId },
      'message check: a Review message is clear on every ticked category and goes out without a pause');
    return { kind: 'send', context: { messageCheck: record } };
  }
  return { kind: 'as_today', context: { messageCheck: record } };
}
