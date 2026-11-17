// The browser, as the platform assistants see it.
//
// Liftoff, the Insights Manager and the Chief AI Officer are not agents. They
// have no agent row, no compiled instruction and no connector bindings, and
// they run their tool loops HERE rather than in the tenant runtime. So they
// cannot reach the runtime's browser tools the way a team agent does — they
// reach the same browser over BrowserSessionsService instead, and this module
// is the whole of that surface.
//
// The tool NAMES are deliberately identical to the runtime's. They are the
// contract the dashboard reads to decide when to open the live pane
// (BROWSER_DRIVING_TOOLS in the frontend's browserDrivingTools.ts), and that
// list is already a hand-maintained mirror with no import to keep it honest.
// Inventing platform-only spellings here would mean an assistant drove a
// browser the person could not see — the exact failure that list exists to
// prevent, arriving from a new direction.
//
// Every decision about the browser stays in the runtime: whether a session
// exists, whether one may be spawned, whether a person has taken the keyboard,
// which vendor owns it, what an error means. This module maps a tool call onto
// an RPC and the answer back into words. It holds no policy of its own.

import crypto from 'crypto';
import { z } from 'zod';
import { Code, ConnectError } from '@connectrpc/connect';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { recordedUrl, sanitizeBrowserText, type SanitizedText } from '@liftoffos/redact';
import type {
  BrowserTaskStep as RuntimeTaskStep,
  PageControl,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { clock, describeCall, describeSegment } from '@liftoffos/browser-record';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';
import { log } from '../infrastructure/logging';
import type { LLMImageBlock, LLMToolDefinition } from '../llm/types';
import { activityStream, readTakeoverActivity, type AssistantActivityOut } from './takeover-activity';

/** The chat surfaces a platform assistant can hold a browser on. Mirrors the
 *  `surface` the pane's REST routes take, because the session is keyed on the
 *  thread and the thread lives in a different table per surface. */
export type AssistantBrowserSurface = 'liftoff' | 'insights' | 'team_plan';

// Imported for use here AND re-exported: every caller in this repo already
// imports these from this module, and the package is where they are defined.
import {
  ACT_IN_BROWSER_SESSION_TOOL,
  ASK_PERSON_TO_TAKE_OVER_BROWSER_SESSION_TOOL,
  BROWSER_TOOLS,
  CHECK_BROWSER_TASK_TOOL,
  FETCH_BROWSER_DOWNLOAD_TOOL,
  LIST_BROWSER_DOWNLOADS_TOOL,
  NAVIGATE_BROWSER_SESSION_TOOL,
  OBSERVED_TEXT_NOTICE,
  READ_ACTIVE_BROWSER_SESSION_TOOL,
  READ_BROWSER_SESSION_ACTIVITY_TOOL,
  READ_BROWSER_SESSION_CONTROLS_TOOL,
  RUN_BROWSER_TASK_TOOL,
  SHOW_BROWSER_PAGE_TOOL,
  START_BROWSER_SESSION_TOOL,
} from '@liftoffos/browser-tools';

export {
  ACT_IN_BROWSER_SESSION_TOOL,
  ASK_PERSON_TO_TAKE_OVER_BROWSER_SESSION_TOOL,
  CHECK_BROWSER_TASK_TOOL,
  FETCH_BROWSER_DOWNLOAD_TOOL,
  LIST_BROWSER_DOWNLOADS_TOOL,
  NAVIGATE_BROWSER_SESSION_TOOL,
  OBSERVED_TEXT_NOTICE,
  READ_ACTIVE_BROWSER_SESSION_TOOL,
  READ_BROWSER_SESSION_ACTIVITY_TOOL,
  READ_BROWSER_SESSION_CONTROLS_TOOL,
  RUN_BROWSER_TASK_TOOL,
  SHOW_BROWSER_PAGE_TOOL,
  START_BROWSER_SESSION_TOOL,
} from '@liftoffos/browser-tools';

/** The tools, from the one place they are defined.
 *
 *  They used to be spelled out here, with a comment promising they matched the
 *  tenant runtime's word for word. Nothing enforced that and it stopped being
 *  true: `read_active_browser_session` meant the page on one host and the
 *  address on this one. `@liftoffos/browser-tools` is now the source, this is
 *  the local name every caller here already imports, and the cast is the one
 *  seam between the package's structural definition and this repo's own
 *  `LLMToolDefinition` — the same shape under two names. */


const showPageSchema = z.object({
  full_page: z.boolean().optional(),
  show_to_user: z.boolean().optional(),
}).strip();

const fetchDownloadSchema = z.object({
  id: z.string().optional(),
  url: z.string().optional(),
}).strip();


export const BROWSER_ASSISTANT_TOOLS: LLMToolDefinition[] = BROWSER_TOOLS as LLMToolDefinition[];

const BROWSER_TOOL_NAMES = new Set(BROWSER_ASSISTANT_TOOLS.map((t) => t.name));

export function isBrowserAssistantTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name);
}

export interface BrowserAssistantToolContext {
  tenantId: string;
  threadId: string;
  surface: AssistantBrowserSurface;
  /** accounts.id of the person whose message triggered this turn.
   *
   *  Absent on any turn nobody sent. The runtime refuses to SPAWN without it —
   *  an interactive browser someone can be asked to take over needs a person
   *  behind it — and that refusal is deliberately not pre-empted here, so the
   *  rule lives in one place. */
  senderAccountId?: string;
}

const navigateSchema = z.object({ url: z.string().url() });
const runTaskSchema = z.object({
  prompt: z.string().min(1),
  success: z.string().optional(),
  constraints: z.array(z.string()).optional(),
});
const checkTaskSchema = z.object({ task_id: z.string().min(1) });
const readActivitySchema = z.object({ limit: z.number().int().optional() });
const readControlsSchema = z.object({
  include_text: z.boolean().optional(),
  start_at: z.number().int().min(0).optional(),
});
const actSchema = z.object({
  snapshot_id: z.string().min(1),
  action: z.enum(['click', 'hover', 'type', 'select', 'press', 'scroll']),
  what: z.string().optional(),
  ref: z.string().optional(),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  direction: z.enum(['up', 'down']).optional(),
  amount: z.number().int().optional(),
});
const askSchema = z.object({ reason: z.string().optional(), withdraw: z.boolean().optional() });

/** Items read_browser_session_activity reads by default, and at most. */
const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 60;

/** One step of a browser task's loop, as the runtime projected it for the
 *  record: a bounded type, an action phrase with the entered value where the
 *  protected data policy allows it and the omitted class where it does not,
 *  the safe page URL, and the flags that say what the policy changed. */
export interface BrowserTaskStep {
  type: string;
  action: string;
  pageUrl: string;
  actionTruncated: boolean;
  pageUrlTruncated: boolean;
  protectedDataOmitted: boolean;
  protectedKind: string;
  pageUrlProtectedDataOmitted: boolean;
  at: string | null;
}

/** What a browser tool call leaves for the conversation's record, beside the
 *  words the model reads.
 *
 *  `outcome` is the trail's one line: for a task whose loop reported its
 *  steps, the loop's own closing message; otherwise the same string the
 *  model is given, so a refusal stays verbatim and the takeover prefix match
 *  in browser-activity.ts keeps holding. `steps` is the loop's steps when the
 *  runtime reported any, `[]` when it reported an empty loop, and null when
 *  the tool reported none at all (navigate, read, start). The completeness
 *  fields say when observation was partial. */
export interface BrowserAssistantToolTrail {
  outcome: string;
  steps: BrowserTaskStep[] | null;
  stepsTruncated: boolean;
  captureGap: boolean;
  gapReason: string;
}

/** Whether this service must write its own fallback row for the call. Derived
 *  from what came back, never from a guess about the runtime's state:
 *
 *    the response echoed the id          false: the runtime wrote the row
 *    the response came back, no echo,
 *      after a session was reached       true: an older runtime recorded nothing
 *    the runtime answered with an error  false: before a session there is nothing
 *      (NotFound, InvalidArgument, ...)  to record; after it the runtime recorded
 *                                        the failure under this id before throwing
 *    the call got no answer              true, as a CAPTURE GAP under the SAME id
 *      (Unavailable, DeadlineExceeded,   with the `[not answered]` outcome, so the
 *      Canceled, a transport error)      merge's exact-id dedupe lets the runtime's
 *                                        row win if it did land
 *    a refusal before a session,         false
 *      or start_browser_session */
export interface BrowserAssistantToolResult {
  /** The words the model reads. */
  content: string;
  /** Frames this call produced, for a read the person asked to be VISUAL.
   *  The caller puts them on the tool result and the provider layer decides
   *  the envelope; see LLMToolResult.images for why that differs by vendor. */
  images?: LLMImageBlock[];
  trail: BrowserAssistantToolTrail;
  /** The id minted for this call before the RPC, or null for a tool that is
   *  deliberately not an activity (start_browser_session) and for a refusal
   *  before a session. */
  activityId: string | null;
  /** The response echoed the id: the runtime wrote the row. */
  runtimeRecorded: boolean;
  legacyFallbackNeeded: boolean;
  /** The instruction as the record keeps it, through the boundary sanitizer,
   *  with what that pass changed. Fallback code never reparses the raw input. */
  safeInstruction: string;
  instructionTruncated: boolean;
  instructionProtectedDataOmitted: boolean;
}

/** Longest instruction the record keeps. */
const INSTRUCTION_CAP = 2000;
/** Longest page title the model is shown. */
const TITLE_CAP = 400;

/**
 * What the tool was told to do, pulled from its input by shape and made safe:
 * the task prompt for a delegated job through the browser text sanitizer, the
 * URL for a navigation through the safe URL projection, nothing for the tools
 * that take no argument. THE boundary sanitizer: it runs once, here, before
 * the RPC, and its result travels on the detailed result as `safeInstruction`
 * with what it changed. Nothing downstream (the chat service's fallback row,
 * the Chief AI Officer's trail) parses the raw input again.
 */
export function browserInstructionFromInput(
  tool: string,
  input: Record<string, unknown>,
): SanitizedText {
  if (tool === RUN_BROWSER_TASK_TOOL && typeof input['prompt'] === 'string') {
    return sanitizeBrowserText(input['prompt'], INSTRUCTION_CAP);
  }
  if (tool === NAVIGATE_BROWSER_SESSION_TOOL && typeof input['url'] === 'string') {
    return recordedUrl(input['url']);
  }
  if (tool === ACT_IN_BROWSER_SESSION_TOOL && typeof input['action'] === 'string') {
    // The runtime phrases the recorded instruction from the matched control;
    // this is the fallback's copy, the action and its reference, with what
    // was entered through the same sanitizer so a protected value never lands.
    const parts = [input['action'], input['ref'], input['value'], input['key'], input['direction']]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (typeof input['text'] === 'string' && input['text'].length > 0) parts.push(JSON.stringify(input['text']));
    return sanitizeBrowserText(parts.join(' '), INSTRUCTION_CAP);
  }
  return { text: '', truncated: false, protectedDataOmitted: false };
}

/** The refusal an instruction that carries protected data gets, before the
 *  RPC. The same check the runtime applies at its own boundary. */
export const PROTECTED_INSTRUCTION_REFUSAL =
  'That instruction carries protected data (a password, one-time code, payment, identity or file value, '
  + 'or a tokenized address) and was not sent to the browser. Do not put protected values in a browser '
  + 'task: open the page and ask the person to take over for that step, or obtain the value from an '
  + 'approved connected source.';

function safeFields(safe: SanitizedText) {
  return {
    safeInstruction: safe.text,
    instructionTruncated: safe.truncated,
    instructionProtectedDataOmitted: safe.protectedDataOmitted,
  };
}

/** The error codes a runtime ANSWERED with: the call reached it and it
 *  decided. Anything else is a call that got no answer. */
const RUNTIME_ANSWERED = new Set<Code>([
  Code.NotFound, Code.InvalidArgument, Code.PermissionDenied, Code.FailedPrecondition, Code.Internal, Code.Unknown,
]);

function runtimeAnswered(err: unknown): boolean {
  return err instanceof ConnectError && RUNTIME_ANSWERED.has(err.code);
}

/** A URL or title as the model may repeat it: the safe projection, and when a
 *  component was replaced or cut, an explicit statement that it is incomplete
 *  so the assistant cannot repeat it as exact. */
function describeSafe(label: string, safe: SanitizedText): string {
  const notes: string[] = [];
  if (safe.protectedDataOmitted) notes.push(`part of the ${label} is protected and not shown`);
  if (safe.truncated) notes.push(`the ${label} is cut short`);
  return notes.length > 0 ? `${safe.text} (${notes.join('; ')})` : safe.text;
}

/** The sentence a task that did not finish reports, read from the runtime's
 *  own result. Null when the task finished, so a finished task still hands
 *  the model everything it FOUND rather than a summary of it, and null for a
 *  result this host does not recognise, which keeps the caller's wording. */
function stoppedMessageOf(resultJson: string): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { status?: unknown; result?: { completed?: unknown; message?: unknown } };
    // Finished by EITHER of the runtime's two ways of saying so. `status` is
    // the one every tail sets; `completed` is absent from a vendor result
    // shape that carries its own, and reading only that field called a
    // finished task stopped.
    if (parsed?.status === 'finished') return null;
    const outcome = parsed?.result;
    if (!outcome || outcome.completed === true) return null;
    return typeof outcome.message === 'string' && outcome.message.trim() ? outcome.message : null;
  } catch {
    return null;
  }
}

function stepOut(step: RuntimeTaskStep): BrowserTaskStep {
  return {
    type: step.type,
    action: step.action,
    pageUrl: step.pageUrl,
    actionTruncated: step.actionTruncated,
    pageUrlTruncated: step.pageUrlTruncated,
    protectedDataOmitted: step.protectedDataOmitted,
    protectedKind: step.protectedKind,
    pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted,
    at: step.at ? timestampDate(step.at).toISOString() : null,
  };
}

/** A tool result, already in the words the model will read.
 *
 *  Never a thrown error and never a fabricated success: a browser that could
 *  not be opened says so, with the reason, so the assistant can tell the person
 *  something true. */
export async function executeBrowserAssistantTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<string> {
  return (await executeBrowserAssistantToolDetailed(name, input, ctx)).content;
}

/** The same call, with what the record keeps beside what the model reads.
 *
 *  The chat service that writes the browser-activity trail calls this form;
 *  every other caller (the Insights Manager's tools, the internal router the
 *  Chief AI Officer reaches) takes the string form above and is unchanged. */
export async function executeBrowserAssistantToolDetailed(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<BrowserAssistantToolResult> {
  try {
    switch (name) {
      case NAVIGATE_BROWSER_SESSION_TOOL:
        return await navigate(input, ctx);
      case RUN_BROWSER_TASK_TOOL:
        return await runTask(input, ctx);
      case START_BROWSER_SESSION_TOOL:
        return plain(await startSession(ctx));
      case READ_ACTIVE_BROWSER_SESSION_TOOL:
        return await readActive(input, ctx);
      case READ_BROWSER_SESSION_ACTIVITY_TOOL:
        return plain(await readActivity(input, ctx));
      case READ_BROWSER_SESSION_CONTROLS_TOOL:
        return await readControls(input, ctx);
      case ACT_IN_BROWSER_SESSION_TOOL:
        return await act(input, ctx);
      case SHOW_BROWSER_PAGE_TOOL:
        return await showPage(input, ctx);
      case ASK_PERSON_TO_TAKE_OVER_BROWSER_SESSION_TOOL:
        return plain(await askPersonToTakeOver(input, ctx));
      case CHECK_BROWSER_TASK_TOOL:
        return plain(await checkTask(input, ctx));
      case LIST_BROWSER_DOWNLOADS_TOOL:
        return plain(await listDownloads(ctx));
      case FETCH_BROWSER_DOWNLOAD_TOOL:
        return plain(await fetchDownload(input, ctx));
      default:
        return plain(`${name} is not a browser tool.`);
    }
  } catch (err) {
    log.error(
      { err: (err as Error).message, tool: name, threadId: ctx.threadId, surface: ctx.surface },
      'platform assistant browser tool failed',
    );
    return plain(UNACCOUNTED_FOR(name));
  }
}

/** What the model is told when a browser call ended in a way nobody can
 *  account for: an exception on our side of the wire, not a refusal the
 *  runtime reasoned about.
 *
 *  It must not claim the browser is gone. A call that changes the page (a
 *  navigation, a task, an action) may well have been taken before it failed,
 *  and saying "the browser is not available" tells a person their click has
 *  not happened when it has, on a turn whose record then holds no trace of
 *  the attempt. So: say what is known, say the page may
 *  have moved, and send the model to look rather than to repeat itself. A
 *  read changed nothing, so it is told plainly that the read failed. */
const MUTATING_BROWSER_TOOLS = new Set<string>([
  NAVIGATE_BROWSER_SESSION_TOOL, RUN_BROWSER_TASK_TOOL, ACT_IN_BROWSER_SESSION_TOOL, START_BROWSER_SESSION_TOOL,
]);
export function UNACCOUNTED_FOR(tool: string): string {
  return MUTATING_BROWSER_TOOLS.has(tool)
    ? 'That browser call ended without an answer, so what the page did with it is not known. The browser may still be open and the page may have moved. Do not repeat it in this turn: read the page to see where it stands, and tell the person plainly that you could not confirm what happened.'
    : 'That browser call ended without an answer, so nothing was read. The browser may still be open. Tell the person plainly, and do not try again in this turn.';
}

/** A result whose record is its words: no steps were reported, nothing was
 *  minted, nothing to fall back for, and no instruction to carry. */
function plain(content: string): BrowserAssistantToolResult {
  return {
    content,
    trail: { outcome: content, steps: null, stepsTruncated: false, captureGap: false, gapReason: '' },
    activityId: null,
    runtimeRecorded: false,
    legacyFallbackNeeded: false,
    ...safeFields(browserInstructionFromInput('', {})),
  };
}

/** A refusal before any session: nothing to record, but the safe instruction
 *  is carried for a caller that keeps its own record. */
function refusedBeforeSession(content: string, safe: SanitizedText): BrowserAssistantToolResult {
  return { ...plain(content), ...safeFields(safe) };
}

/** A call that got no answer: the record is a capture gap under the call's
 *  own id, and this service writes the fallback row with the marker. */
function notAnswered(activityId: string, safe: SanitizedText, err: unknown, tool?: string): BrowserAssistantToolResult {
  log.warn(
    { err: (err as Error).message, activityId },
    'platform assistant browser tool: the runtime did not answer; recording a capture gap',
  );
  const content = tool && MUTATING_BROWSER_TOOLS.has(tool)
    ? 'The browser did not answer, so what the page did with that is not known. The browser may still be open and the page may have moved. Read the page to see where it stands before acting again, and tell the person plainly that you could not confirm what happened.'
    : 'The browser did not answer. Tell the person that, and do not try again in this turn.';
  return {
    content,
    trail: { outcome: NOT_ANSWERED_OUTCOME, steps: null, stepsTruncated: false, captureGap: true, gapReason: 'not_answered' },
    activityId,
    runtimeRecorded: false,
    legacyFallbackNeeded: true,
    ...safeFields(safe),
  };
}

/** The exact outcome marker of a not-answered fallback row; the legacy
 *  reader maps it to a capture gap. */
export const NOT_ANSWERED_OUTCOME = '[not answered]';

/** Open (or reuse) the thread's session.
 *
 *  `agentId` is sent empty on purpose. A platform assistant has no agent row,
 *  and the runtime reads an absent agent as "no opinion about connectors" —
 *  which still lets a workspace's OWN browser key win, so a workspace paying
 *  for Browser Use is not billed a second time for a browser it already funds. */
async function ensure(ctx: BrowserAssistantToolContext) {
  if (!ctx.senderAccountId) {
    return {
      session: null,
      refusal:
        'A browser can only be opened on a message someone actually sent, and this turn has no '
        + 'sender. Tell the person to ask again directly.',
    } as const;
  }
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const res = await client.ensureSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
    agentId: '',
    // WHICH assistant, since agentId cannot say. Without it all three report as
    // one indistinguishable lump: the runtime stores every agent-less session
    // under the same sentinel, so this is the only thing telling them apart.
    assistant: ctx.surface,
    ownerAccountId: ctx.senderAccountId,
  });
  if (res.error || !res.session) {
    return {
      session: null,
      refusal:
        'The browser could not be opened right now. Tell the person plainly; do not retry in '
        + 'this turn.',
    } as const;
  }
  return { session: res.session, refusal: null } as const;
}

async function startSession(ctx: BrowserAssistantToolContext): Promise<string> {
  const { session, refusal } = await ensure(ctx);
  if (!session) return refusal;
  return 'The browser is open and the person can see it. Navigate somewhere or hand it a task.';
}

async function navigate(
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<BrowserAssistantToolResult> {
  const parsed = navigateSchema.safeParse(input);
  if (!parsed.success) return plain('A full URL including https:// is required.');
  // The record's copy of the address: the safe projection, whatever the raw
  // URL carried. The raw URL is used for the navigation itself only.
  const safe = browserInstructionFromInput(NAVIGATE_BROWSER_SESSION_TOOL, input);

  // This forwards into a real browser inside our perimeter, so the address is
  // checked BEFORE the RPC, never after — the cloud metadata endpoint included.
  // Same guard the pane's own goto route applies, for the same reason.
  try {
    await assertPublicUrl(parsed.data.url, { allowHttp: true, context: 'assistant-browser.navigate' });
  } catch (err) {
    if (err instanceof BlockedUrlError) return refusedBeforeSession('That address cannot be opened.', safe);
    throw err;
  }

  const { session, refusal } = await ensure(ctx);
  if (!session) return refusedBeforeSession(refusal, safe);

  // The id is the caller's: minted here, sent on the request, and the row is
  // written under it by the runtime, or by this service's fallback.
  const activityId = crypto.randomUUID();
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  let res;
  try {
    res = await client.goto({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: session.id,
      url: parsed.data.url,
      activityId,
    });
  } catch (err) {
    // A pending request for the person to take over gates the navigation:
    // the runtime answers FailedPrecondition with the gate's own sentence,
    // which the model reads as written. Nothing was recorded.
    if (err instanceof ConnectError && err.code === Code.FailedPrecondition) {
      return refusedBeforeSession(err.rawMessage, safe);
    }
    // A runtime that answered recorded the failure under this id before it
    // threw (or there was nothing to record); a call with no answer is a gap.
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, safe, err, NAVIGATE_BROWSER_SESSION_TOOL);
  }
  const echoed = res.activityId === activityId;
  // The actual destination, as the safe projection with its flags: a
  // redirect, a consent interstitial or a login wall all change it. An older
  // runtime sends no final_url; then the safe requested address stands in.
  const finalUrl: SanitizedText = res.finalUrl
    ? { text: res.finalUrl, truncated: res.finalUrlTruncated, protectedDataOmitted: res.finalUrlProtectedDataOmitted }
    : safe;
  const title: SanitizedText = { text: res.title, truncated: res.titleTruncated, protectedDataOmitted: res.titleProtectedDataOmitted };
  // The result must say how the model itself can read the page: this text is
  // the model's only evidence of what navigating did, and "the person can see
  // it" alone reads as "and you cannot".
  const content =
    `The browser is now on ${describeSafe('address', finalUrl)}`
    + (title.text ? `, titled ${JSON.stringify(describeSafe('title', title))},` : '')
    + ' and the person can see it. '
    + 'You have not read the page: to describe its content, read it with your web tools '
    + 'or hand a reading task to run_browser_task.';
  return {
    content,
    trail: {
      outcome: `opened ${finalUrl.text}${title.text ? `; title: ${title.text}` : ''}`,
      steps: null, stepsTruncated: false, captureGap: false, gapReason: '',
    },
    activityId,
    runtimeRecorded: echoed,
    legacyFallbackNeeded: !echoed,
    ...safeFields(safe),
  };
}

async function runTask(
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<BrowserAssistantToolResult> {
  const parsed = runTaskSchema.safeParse(input);
  if (!parsed.success) return plain('A prompt describing the job is required.');
  // The same check the runtime applies at its boundary, applied here BEFORE
  // the RPC: an instruction from which protected data was removed is not
  // dispatched, and only the sanitized instruction is retained.
  const safe = browserInstructionFromInput(RUN_BROWSER_TASK_TOOL, input);
  if (safe.protectedDataOmitted) {
    return refusedBeforeSession(PROTECTED_INSTRUCTION_REFUSAL, safe);
  }
  if (!ctx.senderAccountId) {
    return refusedBeforeSession('A browser can only be driven on a message someone actually sent, and this turn has no sender.', safe);
  }

  const activityId = crypto.randomUUID();
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  let res;
  try {
    res = await client.runBrowserTask({
      tenantContext: { tenantId: ctx.tenantId },
      threadId: ctx.threadId,
      prompt: parsed.data.prompt,
      success: parsed.data.success ?? '',
      constraints: parsed.data.constraints ?? [],
      // This surface has `check_browser_task`, so a long task may carry on
      // and be collected on a later turn rather than cut off at the bound.
      canCollect: true,
      ownerAccountId: ctx.senderAccountId,
      agentId: '',
      // Either call can be the first to open a session, so both must label it.
      assistant: ctx.surface,
      activityId,
    });
  } catch (err) {
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, safe, err, RUN_BROWSER_TASK_TOOL);
  }

  const echoed = res.activityId === activityId;
  // A response with a session reached a browser: an older runtime that
  // recorded nothing needs the fallback; a refusal before any session does
  // not, since there is no browser behaviour to replay.
  const reachedBrowser = res.session !== undefined;
  const recordFields = {
    activityId: reachedBrowser ? activityId : null,
    runtimeRecorded: echoed,
    legacyFallbackNeeded: reachedBrowser && !echoed,
    ...safeFields(safe),
  };

  // The runtime's refusals are the useful ones — the person has taken over, the
  // session idled out, no browser is available — so they are passed through as
  // written rather than replaced with a generic failure. Verbatim, as the whole
  // outcome: the trail's takeover mark is a prefix match on that sentence.
  if (!res.success) {
    const content = res.error || 'The browser could not finish that.';
    return {
      content,
      trail: { outcome: content, steps: null, stepsTruncated: false, captureGap: false, gapReason: '' },
      ...recordFields,
    };
  }

  const result = res.resultJson.length > 0
    ? new TextDecoder().decode(res.resultJson)
    : '';
  // A task that did not finish is reported in the runtime's own words.
  // "The browser finished. What it reported: {json}" was said of a task that
  // never ran a step, and the only readable thing in the blob was the
  // sentence inside it, so an assistant could only tell the person the reason
  // was "not fully clear" and ask them to do the step by hand. The runtime now puts what stopped the task,
  // and what to do next, in `result.message`.
  const stopMessage = stoppedMessageOf(result);
  const content = stopMessage
    ? stopMessage
    : result
      ? `The browser finished. What it reported: ${result}`
      : 'The browser finished the task.';
  // The record's half. PRESENCE of the trail is the signal: absent means the
  // runtime reported no steps at all, present with none means the loop ran
  // and took none. When present, the record keeps the loop's own closing
  // message as the outcome rather than the model's decorated string, with
  // the completeness fields that say when observation was partial.
  const trail: BrowserAssistantToolTrail = res.trail
    ? {
      outcome: res.trail.message,
      steps: res.trail.steps.map(stepOut),
      stepsTruncated: res.trail.stepsTruncated,
      captureGap: res.trail.captureGap,
      gapReason: res.trail.gapReason,
    }
    : { outcome: content, steps: null, stepsTruncated: false, captureGap: false, gapReason: '' };
  return { content, trail, ...recordFields };
}

/** What a page read was asked for. `mode` is the compact selector and
 *  `include_screenshot` the explicit boolean; either reaches the same place,
 *  and the runtime's own tool takes both for the same reason. */
const readActiveSchema = z.object({
  include_screenshot: z.boolean().optional(),
  mode: z.enum(['text', 'visual', 'both']).optional(),
  full_page: z.boolean().optional(),
}).strip();

/** The frame behind a signed URL, as the block a provider carries.
 *
 *  Best effort on purpose: the words are the read and the picture rides along,
 *  so a signed URL that has expired or a fetch that fails costs the screenshot
 *  and not the answer. Bounded because a frame crosses into a model's context:
 *  a capture larger than the cap is dropped rather than truncated, since half
 *  a PNG is not a smaller picture, it is a broken one. */
const MAX_FRAME_BYTES = 5 * 1024 * 1024;

async function frameFor(signedUrl: string): Promise<LLMImageBlock[]> {
  if (!signedUrl) return [];
  try {
    const res = await fetch(signedUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return [];
    return [{ mimeType: 'image/png', dataBase64: bytes.toString('base64') }];
  } catch {
    return [];
  }
}

/** The page's rendered text for `readActive`, or '' when this browser cannot
 *  give it. Bounded by the runtime's own PAGE_TEXT_CAP (12,000 characters), so
 *  the cost of reading a page is the cap and not the page. The controls come
 *  back on the same response and are dropped: this tool answers what the page
 *  SAYS, and `read_browser_session_controls` answers what can be clicked. */
async function pageTextFor(ctx: BrowserAssistantToolContext, sessionId: string): Promise<string> {
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const snap = await client.snapshotPage({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId,
      threadId: ctx.threadId,
      recordActivity: false,
      activityId: '',
      includeText: true,
      startAt: 0,
    });
    if (!snap.text) return '';
    const notes: string[] = [];
    if (snap.textTruncated) notes.push('cut short');
    if (snap.textProtectedDataOmitted) notes.push('protected parts not shown');
    return notes.length > 0 ? `(${notes.join('; ')})\n${snap.text}` : snap.text;
  } catch {
    // Every failure reads the same here: no text, and the address still answers.
    return '';
  }
}


/**
 * Collect a browser task that outlived the turn that started it.
 *
 * A browser task used to hold the turn open for as long as it ran, so it
 * needed a bound a person would tolerate and anything genuinely slow failed
 * short of the finish. A long one carries on now, and this is how what came
 * of it gets back.
 */
async function checkTask(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<string> {
  const parsed = checkTaskSchema.safeParse(input);
  if (!parsed.success) return 'That needs the id the task gave you when it said it was carrying on.';
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const found = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  if (!found.session) return 'No browser is open on this conversation, so there is nothing left running in it.';
  const res = await client.checkBrowserTask({
    tenantContext: { tenantId: ctx.tenantId },
    sessionId: found.session.id,
    taskId: parsed.data.task_id,
  });
  return res.message || 'That task reported nothing.';
}

/**
 * The files this browser has downloaded.
 *
 * The runtime hears a download on the session's own browser connection, so
 * this answers on every vendor. It used to answer on one: the tools called
 * the single vendor with a download API and refused on the other three, while
 * the pane runs a different one by default.
 */
async function listDownloads(ctx: BrowserAssistantToolContext): Promise<string> {
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const found = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  if (!found.session) return 'No browser is open on this conversation.';
  const res = await client.listSessionDownloads({
    tenantContext: { tenantId: ctx.tenantId },
    sessionId: found.session.id,
  });
  if (res.downloads.length === 0) {
    return 'This browser has not downloaded anything. A file the page only points at was never downloaded: '
      + `pass its address to \`${FETCH_BROWSER_DOWNLOAD_TOOL}\` to bring it here.`;
  }
  const lines = res.downloads.map((d) => {
    const name = d.suggestedFileName || 'a file';
    const from = d.originUrl ? ` from ${recordedUrl(d.originUrl).text}` : '';
    return `- ${name}${from} (id ${d.id})`;
  });
  return `${res.downloads.length === 1 ? 'One file' : `${res.downloads.length} files`} downloaded in this browser, oldest first:\n${lines.join('\n')}`;
}

/** Bring a file out of the browser and put it in front of the person.
 *
 *  Two routes in, one act. A download the browser made is named by its id; a
 *  file the page merely points at, which is most of what a page GENERATES, is
 *  named by its address. Without this, a person could watch a page make a
 *  video and be handed a screenshot of the page instead.
 *
 *  The file is owned by the CONVERSATION, for the reason showPage records
 *  below: these assistants have no `internal_agents` row and the person
 *  uploaded nothing. */
async function fetchDownload(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<string> {
  const parsed = fetchDownloadSchema.safeParse(input).data ?? {};
  const askedId = (parsed.id ?? '').trim();
  const askedUrl = (parsed.url ?? '').trim();
  if (!askedId && !askedUrl) {
    return `That needs either the id of a download from \`${LIST_BROWSER_DOWNLOADS_TOOL}\`, or the address of the file on the page.`;
  }
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const found = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  if (!found.session) return 'No browser is open on this conversation.';

  const res = await client.fetchSessionFile({
    tenantContext: { tenantId: ctx.tenantId },
    sessionId: found.session.id,
    downloadId: askedId,
    url: askedUrl,
  });
  // The runtime refuses with the reason, which is the useful thing to relay.
  if (res.refusal) return res.refusal;
  if (res.content.length === 0) return 'That file came back empty, so there is nothing to show.';

  const bytes = Buffer.from(res.content);
  const filename = res.filename || 'browser-file';
  const { isAllowedMediaMimeType } = await import('../generated-files/store');
  try {
    // The Chief AI Officer's conversation cannot show media inline yet, so a
    // video there becomes a card the person can open rather than nothing.
    if (isAllowedMediaMimeType(res.contentType) && ctx.surface !== 'team_plan') {
      const { attachMedia } = await import('../media/attach');
      await attachMedia({
        surface: ctx.surface,
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        agentId: null,
        bytes,
        mimeType: res.contentType,
        filename,
      });
      return `${filename} is in the conversation now, and the person can see it.`;
    }
    const { storeMediaObject } = await import('../generated-files/store');
    const dot = filename.lastIndexOf('.');
    const baseName = (dot > 0 ? filename.slice(0, dot) : filename).slice(0, 255) || 'browser-file';
    const stored = await storeMediaObject({
      tenantId: ctx.tenantId,
      agentId: null,
      surface: ctx.surface,
      baseName,
      outputType: 'binary',
      bytes,
      originalFilename: filename,
      uploadedMimeType: res.contentType,
      conversationId: ctx.threadId,
      signUrl: false,
    });
    const { presentFile } = await import('../generated-files/present');
    await presentFile({
      tenantId: ctx.tenantId,
      fileId: stored.id,
      surface: ctx.surface,
      conversationId: ctx.threadId,
      agentId: null,
    });
    return `${stored.filename} is in the conversation now, as a card the person can open.`;
  } catch (err) {
    // No fabricated success: a file that did not post must not be reported as
    // one, or the reply says "here it is" over nothing.
    log.warn(
      { error: (err as Error).message, tenantId: ctx.tenantId, surface: ctx.surface },
      'assistant-tools: could not put the browser file in the conversation',
    );
    return 'The file came back from the browser but could not be put in the conversation. Tell the person that plainly.';
  }
}

/**
 * Take a picture of the page, and put it in the conversation when asked to.
 *
 * Two audiences, and the flag decides which. Without `show_to_user` the frame
 * goes where it has always gone — into the model's context, as vision — and
 * the person sees nothing. With it, the bytes are stored through the one
 * attach helper (ADR-051) and appear as a picture in the conversation, which
 * is the first way one of these assistants can put a file in front of anybody.
 *
 * The stored file is owned by the CONVERSATION. These assistants have no
 * `internal_agents` row, and the person they are talking to did not upload
 * anything, so there is no honest agent or account to name — and naming one
 * anyway would put the file in some agent's audit trail, or hand it to a
 * retention sweep that deletes a person's unsent uploads.
 */
async function showPage(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<BrowserAssistantToolResult> {
  const parsed = showPageSchema.safeParse(input).data ?? {};
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const res = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  if (!res.session) return plain('No browser is open on this conversation.');

  const activityId = crypto.randomUUID();
  let state;
  try {
    state = await client.getPageState({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: res.session.id,
      recordActivity: true,
      activityId,
      fullPage: parsed.full_page === true,
    });
  } catch (err) {
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, browserInstructionFromInput(SHOW_BROWSER_PAGE_TOOL, {}), err, SHOW_BROWSER_PAGE_TOOL);
  }

  const images = await frameFor(state.screenshotSignedUrl);
  if (images.length === 0) {
    return plain('The page could not be captured just now; nothing was shown.');
  }

  /** Every exit of this tool differs only in what it says happened, so the
   *  envelope is built once. */
  const shaped = (content: string, outcome: string): BrowserAssistantToolResult => ({
    content,
    images,
    trail: { outcome, steps: null, stepsTruncated: false, captureGap: false, gapReason: '' },
    activityId,
    runtimeRecorded: state.activityId === activityId,
    legacyFallbackNeeded: state.activityId !== activityId,
    ...safeFields(browserInstructionFromInput(SHOW_BROWSER_PAGE_TOOL, {})),
  });

  // Only the model sees it unless the person asked to be shown.
  if (parsed.show_to_user !== true) {
    return shaped('The screenshot of this page is attached.', 'took a picture of the page');
  }

  // team_plan has no adapter in the attach helper yet, so the Chief AI Officer
  // is told the truth rather than handed a silent failure.
  if (ctx.surface === 'team_plan') {
    return shaped(
      'This conversation cannot show pictures yet. The screenshot was taken and only you can see it.',
      'took a picture of the page; this conversation cannot show it',
    );
  }

  try {
    const { attachMedia } = await import('../media/attach');
    await attachMedia({
      surface: ctx.surface,
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      // The conversation owns it: no agent made it and no person uploaded it.
      agentId: null,
      bytes: Buffer.from(images[0].dataBase64, 'base64'),
      mimeType: 'image/png',
      filename: 'page.png',
    });
  } catch (err) {
    // No fabricated success: a picture that did not post must not be reported
    // as one, or the reply says "here it is" over nothing.
    log.warn({ error: (err as Error).message, tenantId: ctx.tenantId }, 'assistant-tools: could not show page');
    return shaped(
      'The screenshot was taken but could not be put in the conversation. Only you can see it.',
      'took a picture of the page; it could not be shown',
    );
  }

  return shaped(
    'The screenshot is in the conversation now, and the person can see it.',
    'showed a picture of the page',
  );
}

async function readActive(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<BrowserAssistantToolResult> {
  const parsed = readActiveSchema.safeParse(input).data ?? {};
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const res = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  if (!res.session) return plain('No browser is open on this conversation.');
  const activityId = crypto.randomUUID();
  let state;
  try {
    state = await client.getPageState({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: res.session.id,
      // A read is work: the runtime records it under this id.
      recordActivity: true,
      activityId,
      fullPage: parsed.full_page === true,
    });
  } catch (err) {
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, browserInstructionFromInput(READ_ACTIVE_BROWSER_SESSION_TOOL, {}), err, READ_ACTIVE_BROWSER_SESSION_TOOL);
  }
  const echoed = state.activityId === activityId;
  // Assistant code uses only the safe projection. An older runtime sends no
  // recorded_url; then the live URL is projected here, never repeated raw.
  const url: SanitizedText = state.recordedUrl
    ? { text: state.recordedUrl, truncated: state.recordedUrlTruncated, protectedDataOmitted: state.recordedUrlProtectedDataOmitted }
    : recordedUrl(state.url);
  const title: SanitizedText = state.recordedTitle
    ? { text: state.recordedTitle, truncated: state.recordedTitleTruncated, protectedDataOmitted: state.recordedTitleProtectedDataOmitted }
    : sanitizeBrowserText('', TITLE_CAP);
  const where = url.text
    ? `The browser is on ${describeSafe('address', url)}${title.text ? `, titled ${JSON.stringify(describeSafe('title', title))}` : ''}.`
    : 'A browser is open but has not been to a page yet.';
  // The page's own words, so this tool answers "what does it say" here the way
  // it does on the runtime, where it has always returned the page as markdown.
  // Three assistants held the same tool NAME for the address alone, so the one
  // instruction that tells a model to read the page before answering could not
  // be written once for four hosts.
  //
  // Best effort, and deliberately second: `getPageState` above is what makes
  // this a recorded read and refreshes the session's address, and it answers on
  // a vendor that cannot snapshot at all. A snapshot that is unimplemented, slow
  // or broken leaves the address answer standing rather than failing the read.
  // `recordActivity: false` because the call above already wrote the row: one
  // tool call is one entry in the record, as it was before.
  const wantsText = parsed.mode !== 'visual';
  const wantsFrame = parsed.mode === 'visual' || parsed.mode === 'both' || parsed.include_screenshot === true;
  const text = wantsText && url.text ? await pageTextFor(ctx, res.session.id) : '';
  // The frame the runtime just took for this read. `state.screenshotSignedUrl`
  // is the same capture, so asking for a picture costs no second visit to the
  // page; a signed URL that cannot be fetched leaves the words standing.
  const images = wantsFrame ? await frameFor(state.screenshotSignedUrl) : [];
  const parts = [where];
  if (text) parts.push(OBSERVED_TEXT_NOTICE, 'Page text:', text);
  if (images.length > 0) parts.push('The screenshot of this page is attached.');
  else if (wantsFrame) parts.push('A screenshot was asked for and could not be taken; the words above are what was read.');
  const content = parts.join('\n');
  return {
    content,
    ...(images.length > 0 ? { images } : {}),
    trail: {
      outcome: url.text ? `read ${url.text}${title.text ? `; title: ${title.text}` : ''}${text ? '; and the page text' : ''}` : where,
      steps: null, stepsTruncated: false, captureGap: false, gapReason: '',
    },
    activityId,
    runtimeRecorded: echoed,
    legacyFallbackNeeded: !echoed,
    ...safeFields(browserInstructionFromInput(READ_ACTIVE_BROWSER_SESSION_TOOL, {})),
  };
}

// ── The record, the controls, one action, and the ask ─────────────────────

/** Newest recorded pane calls on the thread, from the runtime's stream, at
 *  most `limit`. `hasMore` says older rows were left unfetched. */
async function newestCalls(
  tenantId: string,
  threadId: string,
  limit: number,
): Promise<{ rows: AssistantActivityOut[]; hasMore: boolean }> {
  const stream = activityStream(tenantId, threadId);
  const rows: AssistantActivityOut[] = [];
  while (rows.length < limit) {
    const item = await stream.pop();
    if (!item) break;
    rows.push(item.row);
  }
  return { rows, hasMore: stream.hasMore() };
}

/** The record read back: the person's segments and the recorded calls,
 *  interleaved by time, newest last, each as the one prose renderer phrases
 *  it. Reads only; nothing is recorded for reading the record. */
async function readActivity(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<string> {
  const parsed = readActivitySchema.safeParse(input);
  const requested = parsed.success && typeof parsed.data.limit === 'number' ? parsed.data.limit : ACTIVITY_DEFAULT_LIMIT;
  const limit = Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, requested));
  const [segments, calls] = await Promise.all([
    readTakeoverActivity(ctx.tenantId, ctx.threadId),
    newestCalls(ctx.tenantId, ctx.threadId, limit),
  ]);
  const items = [
    ...segments.takeovers.map((t) => ({ at: Date.parse(t.startedAt), line: `${clock(t.startedAt)} ${describeSegment(t)}` })),
    ...calls.rows.map((c) => ({ at: Date.parse(c.createdAt), line: `${clock(c.createdAt)} ${describeCall(c)}` })),
  ].sort((a, b) => b.at - a.at);
  const kept = items.slice(0, limit).reverse();
  const truncated = segments.truncated || calls.hasMore || items.length > limit;
  if (kept.length === 0) return `Nothing has been recorded in this conversation's browser yet. ${OBSERVED_TEXT_NOTICE}`;
  return [
    OBSERVED_TEXT_NOTICE,
    ...kept.map((i) => `- ${i.line}`),
    ...(truncated ? ['Older items were left out; ask again with a larger limit to read further back.'] : []),
  ].join('\n');
}

/** The thread's open session, or null with the sentence the model reads. */
async function activeSession(ctx: BrowserAssistantToolContext) {
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const res = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.threadId,
  });
  return res.session ?? null;
}

const NO_SESSION = 'No browser is open on this conversation.';

/** An older runtime without the RPC. Not a gap in the record: nothing was
 *  attempted in the browser. */
function unimplemented(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.Unimplemented;
}

/** One control as the model reads it: the reference first, then what it is. */
function describeControl(c: PageControl): string {
  const name = c.name ? ` ${JSON.stringify(c.name)}` : '';
  const notes: string[] = [];
  if (c.inputType) notes.push(c.inputType);
  if (c.protectedKind) notes.push(`protected: ${c.protectedKind}`);
  else if (c.valueState) notes.push(`value: ${JSON.stringify(c.valueState)}`);
  if (c.disabled) notes.push('disabled');
  if (c.offscreen) notes.push('out of view');
  if (c.nameTruncated) notes.push('name cut short');
  if (c.nameProtectedDataOmitted) notes.push('part of the name is protected and not shown');
  return `- ${c.ref}: ${c.role || 'control'}${name}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

/** The page's controls with a reference each, over SnapshotPage. Recorded by
 *  the runtime as a read of the controls, under this call's id. */
async function readControls(
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<BrowserAssistantToolResult> {
  const parsed = readControlsSchema.safeParse(input);
  if (!parsed.success) return plain('include_text must be a boolean and start_at a whole number when given.');
  const session = await activeSession(ctx);
  if (!session) return plain(NO_SESSION);
  const activityId = crypto.randomUUID();
  const safe = browserInstructionFromInput(READ_BROWSER_SESSION_CONTROLS_TOOL, input);
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  let res;
  try {
    res = await client.snapshotPage({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: session.id,
      threadId: ctx.threadId,
      recordActivity: true,
      activityId,
      includeText: parsed.data.include_text === true,
      startAt: parsed.data.start_at ?? 0,
    });
  } catch (err) {
    if (unimplemented(err)) return plain('This browser cannot list its controls; hand the job to run_browser_task.');
    if (err instanceof ConnectError && err.code === Code.Unavailable) return plain(err.rawMessage);
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, safe, err, READ_BROWSER_SESSION_CONTROLS_TOOL);
  }
  const url: SanitizedText = { text: res.recordedUrl, truncated: res.recordedUrlTruncated, protectedDataOmitted: res.recordedUrlProtectedDataOmitted };
  const title: SanitizedText = { text: res.recordedTitle, truncated: res.recordedTitleTruncated, protectedDataOmitted: res.recordedTitleProtectedDataOmitted };
  const from = parsed.data.start_at ?? 0;
  const lines: string[] = [
    `The page is on ${describeSafe('address', url)}${title.text ? `, titled ${JSON.stringify(describeSafe('title', title))}` : ''}. `
    + `snapshot_id: ${res.snapshotId}. `
    + (res.controls.length > 0
      ? `Controls ${from + 1} to ${from + res.controls.length} of ${res.total}`
        + (res.controlsTruncated ? `; read again with start_at ${from + res.controls.length} for the rest, or scroll and read again.` : '.')
      : `No controls were found${res.total > 0 ? ` from ${from}; the page has ${res.total}` : ''}.`),
    OBSERVED_TEXT_NOTICE,
    ...res.controls.map(describeControl),
  ];
  if (res.framesNotListed) lines.push('A frame on the page could not be observed; its controls are not listed.');
  if (res.text) {
    const notes: string[] = [];
    if (res.textTruncated) notes.push('cut short');
    if (res.textProtectedDataOmitted) notes.push('protected parts not shown');
    lines.push(`Page text${notes.length > 0 ? ` (${notes.join('; ')})` : ''}:`, res.text);
  }
  const echoed = res.activityId === activityId;
  return {
    content: lines.join('\n'),
    trail: {
      outcome: `read ${res.controls.length} of ${res.total} controls on ${url.text}${title.text ? `; title: ${title.text}` : ''}`,
      steps: null, stepsTruncated: false, captureGap: false, gapReason: '',
    },
    activityId,
    runtimeRecorded: echoed,
    legacyFallbackNeeded: !echoed,
    ...safeFields(safe),
  };
}

/** One action on one control, over ActOnPage. The runtime applies every
 *  gate and records the action under this call's id; a refusal comes back
 *  explained and is given to the model as written. */
async function act(
  input: Record<string, unknown>,
  ctx: BrowserAssistantToolContext,
): Promise<BrowserAssistantToolResult> {
  const parsed = actSchema.safeParse(input);
  if (!parsed.success) return plain('snapshot_id and one of click, hover, type, select, press or scroll are required.');
  const safe = browserInstructionFromInput(ACT_IN_BROWSER_SESSION_TOOL, input);
  const session = await activeSession(ctx);
  if (!session) return refusedBeforeSession(NO_SESSION, safe);
  const activityId = crypto.randomUUID();
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const a = parsed.data;
  let res;
  try {
    res = await client.actOnPage({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: session.id,
      threadId: ctx.threadId,
      snapshotId: a.snapshot_id,
      action: a.action,
      // The words name the control and the runtime picks it out; a reference
      // overrides them.
      what: a.what ?? '',
      ref: a.ref ?? '',
      text: a.text ?? '',
      submit: a.submit === true,
      value: a.value ?? '',
      key: a.key ?? '',
      direction: a.direction ?? '',
      amount: a.amount ?? 0,
      activityId,
    });
  } catch (err) {
    if (unimplemented(err)) return refusedBeforeSession('This browser cannot act on a control; hand the job to run_browser_task.', safe);
    if (err instanceof ConnectError && err.code === Code.Unavailable) return refusedBeforeSession(err.rawMessage, safe);
    // A pending request for the person to take over gates the action as it
    // gates a navigation: the runtime answers FailedPrecondition with the
    // gate's own sentence, having recorded the refusal itself.
    if (err instanceof ConnectError && err.code === Code.FailedPrecondition) return refusedBeforeSession(err.rawMessage, safe);
    if (runtimeAnswered(err)) throw err;
    return notAnswered(activityId, safe, err, ACT_IN_BROWSER_SESSION_TOOL);
  }
  const echoed = res.activityId === activityId;
  const recordFields = {
    activityId,
    runtimeRecorded: echoed,
    legacyFallbackNeeded: !echoed,
    ...safeFields(safe),
  };
  if (!res.acted) {
    const content = res.message || `The action was refused (${res.refusalKind || 'unknown'}).`;
    return {
      content,
      trail: { outcome: content, steps: null, stepsTruncated: false, captureGap: false, gapReason: '' },
      ...recordFields,
    };
  }
  const url: SanitizedText = { text: res.recordedUrl, truncated: res.recordedUrlTruncated, protectedDataOmitted: res.recordedUrlProtectedDataOmitted };
  const title: SanitizedText = { text: res.recordedTitle, truncated: res.recordedTitleTruncated, protectedDataOmitted: res.recordedTitleProtectedDataOmitted };
  const content =
    `Done. The page is now on ${describeSafe('address', url)}${title.text ? `, titled ${JSON.stringify(describeSafe('title', title))}` : ''}. `
    + (res.personTookOverDuring
      ? 'The person took over the browser while this action ran. Stop acting in the browser; wait for them to hand it back. '
      : '')
    + 'Read the controls again before the next action: the references belonged to the reading you just acted on.';
  return {
    content,
    trail: {
      outcome: `${a.action}${a.ref ? ` ${a.ref}` : ''}: now on ${url.text}${title.text ? `; title: ${title.text}` : ''}`
        + (res.personTookOverDuring ? ' [the person took over while this action ran]' : ''),
      steps: null, stepsTruncated: false, captureGap: false, gapReason: '',
    },
    ...recordFields,
  };
}

/** Ask the person to take over, or withdraw the ask, over RequestIntervention.
 *  The reason travels to the runtime and to the model; the pane learns only
 *  that a request is open. */
async function askPersonToTakeOver(input: Record<string, unknown>, ctx: BrowserAssistantToolContext): Promise<string> {
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) return 'reason must be text and withdraw a boolean when given.';
  const session = await activeSession(ctx);
  if (!session) return NO_SESSION;
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const withdraw = parsed.data.withdraw === true;
  const reason = (parsed.data.reason ?? '').trim();
  if (!withdraw && !reason) return 'Say in reason what the person needs to do, and where.';
  let res;
  try {
    res = await client.requestIntervention({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: session.id,
      threadId: ctx.threadId,
      reason,
      withdraw,
    });
  } catch (err) {
    if (unimplemented(err)) return 'This browser cannot carry a request to the person; say in your reply what they need to do and where.';
    throw err;
  }
  if (withdraw) {
    return res.withdrawn
      ? 'The request was withdrawn. You can act in the browser again.'
      : 'There was no open request to withdraw.';
  }
  return res.alreadyPending
    ? 'A request is already open; the browser panel is telling the person. Say what they need to do in your reply and end your turn.'
    : 'The browser panel is telling the person you asked. Say the same thing in your reply so they know what to do, then end your turn; you get the next turn when they hand the browser back.';
}
