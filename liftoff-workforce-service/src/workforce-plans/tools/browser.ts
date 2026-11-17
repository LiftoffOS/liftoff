// The browser, as the Chief AI Officer's tools.
//
// The CAIO runs here, against this service's own database, but the browser it
// drives belongs to the tenant runtime and is reached through platform-backend.
// So these are thin calls onto ONE endpoint there, which runs the identical
// function Liftoff and the Insights Manager call in-process
// (browser-sessions/assistant-tools).
//
// Deliberately not a browser client of our own. What a refusal says, when a
// session may be spawned, which addresses are refused, which vendor owns the
// browser — all of that must be the same for all three platform assistants, and
// a second client here would be a second copy of every one of those decisions.
//
// The tool NAMES are the tenant runtime's, because the dashboard opens the live
// pane by matching them. A CAIO-only spelling would mean it drove a browser the
// person could not see.

import { log } from '../../infrastructure/logging.js';
import {
  ACT_IN_BROWSER_SESSION_TOOL,
  BROWSER_TOOLS,
  NAVIGATE_BROWSER_SESSION_TOOL,
  RUN_BROWSER_TASK_TOOL,
  START_BROWSER_SESSION_TOOL,
} from '@liftoffos/browser-tools';
import { loadConfig } from '../../infrastructure/config.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';



/** One step of a browser task's loop, as platform-backend returns it. */
export interface BrowserToolStep {
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

/** What a browser tool answers. `steps` is present only when the endpoint
 *  sent a list (a browser task); the safe-instruction fields travel on every
 *  answer that had an instruction, so the trail persists the safe text and
 *  never the raw argument. */
export interface BrowserToolResult {
  message: string;
  safeInstruction?: string;
  instructionTruncated?: boolean;
  instructionProtectedDataOmitted?: boolean;
  steps?: BrowserToolStep[];
  stepsTruncated?: boolean;
  captureGap?: boolean;
  gapReason?: string;
}

interface RawBrowserResponse {
  message?: string;
  steps?: unknown;
  stepsTruncated?: unknown;
  captureGap?: unknown;
  gapReason?: unknown;
  safeInstruction?: unknown;
  instructionTruncated?: unknown;
  instructionProtectedDataOmitted?: unknown;
}

/** A step as the wire carried it, every flag and the timestamp mapped rather
 *  than dropped. */
function stepFromWire(raw: unknown): BrowserToolStep {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    type: typeof s.type === 'string' ? s.type : '',
    action: typeof s.action === 'string' ? s.action : '',
    pageUrl: typeof s.pageUrl === 'string' ? s.pageUrl : '',
    actionTruncated: s.actionTruncated === true,
    pageUrlTruncated: s.pageUrlTruncated === true,
    protectedDataOmitted: s.protectedDataOmitted === true,
    protectedKind: typeof s.protectedKind === 'string' ? s.protectedKind : '',
    pageUrlProtectedDataOmitted: s.pageUrlProtectedDataOmitted === true,
    at: typeof s.at === 'string' ? s.at : null,
  };
}

/** A call that ended without an answer, said as what is known.
 *
 *  A call that changes the page may have been taken before it failed, so the
 *  sentence must not say the browser is unavailable: saying so tells a person
 *  their click had not happened when it may have, on a turn whose record then
 *  holds no trace of it. The same words platform-backend gives
 *  Liftoff and the Insights Manager, so the three assistants say one thing. */
const MUTATING = new Set<string>([
  NAVIGATE_BROWSER_SESSION_TOOL,
  RUN_BROWSER_TASK_TOOL,
  ACT_IN_BROWSER_SESSION_TOOL,
  START_BROWSER_SESSION_TOOL,
]);
function unaccountedFor(tool: string): string {
  return MUTATING.has(tool)
    ? 'That browser call ended without an answer, so what the page did with it is not known. The browser may still be open and the page may have moved. Do not repeat it in this turn: read the page to see where it stands, and tell the person plainly that you could not confirm what happened.'
    : 'That browser call ended without an answer, so nothing was read. The browser may still be open. Tell the person plainly, and do not try again in this turn.';
}

async function callPlatformBackend(
  tool: string,
  input: Record<string, unknown>,
  ctx: WorkforcePlanToolContext,
): Promise<BrowserToolResult> {
  if (!ctx.threadId) {
    // Every chat turn has a thread. Without one there is nothing to hang a
    // session on, and a browser opened outside a conversation is on screen for
    // nobody.
    return { message: 'A browser can only be opened inside a conversation.' };
  }

  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/api/internal/assistant-browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        tool,
        input,
        // The person whose message started this turn. Platform-backend needs it
        // to spawn a session and refuses without one, which is the rule we want
        // rather than one to work around.
        senderAccountId: ctx.accountId,
      }),
    });
  } catch (err) {
    log.error({ error: (err as Error).message, tool }, 'browser tool: fetch to platform-backend failed');
    return { message: unaccountedFor(tool) };
  }

  if (resp.status === 401) {
    // A misconfiguration, not something the model can act on — but it must not
    // read as "the browser said no".
    log.error({ tool }, 'browser tool: service authentication failed — check WORKFORCE_SERVICE_TOKEN');
    // The call never reached the browser, so nothing was done to the page.
    return { message: 'The browser is not available right now.' };
  }

  if (!resp.ok) {
    log.error({ tool, status: resp.status }, 'browser tool: unexpected status from platform-backend');
    return { message: unaccountedFor(tool) };
  }

  const body = await resp.json() as RawBrowserResponse;
  const result: BrowserToolResult = { message: body.message ?? 'The browser finished.' };
  if (typeof body.safeInstruction === 'string') {
    result.safeInstruction = body.safeInstruction;
    result.instructionTruncated = body.instructionTruncated === true;
    result.instructionProtectedDataOmitted = body.instructionProtectedDataOmitted === true;
  }
  if (Array.isArray(body.steps)) {
    result.steps = body.steps.map(stepFromWire);
    result.stepsTruncated = body.stepsTruncated === true;
    result.captureGap = body.captureGap === true;
    result.gapReason = typeof body.gapReason === 'string' ? body.gapReason : '';
  }
  return result;
}

function browserTool(
  name: string,
  description: string,
  input_schema: WorkforcePlanTool['definition']['input_schema'],
): WorkforcePlanTool {
  return {
    definition: { name, description, input_schema },
    execute: (input, ctx) => callPlatformBackend(name, input, ctx),
  };
}

/** Wording matches what Liftoff and the Insights Manager are told, so the three
 *  assistants describe the same capability the same way. */
/** The tools, from the one place they are defined.
 *
 *  These were spelled out here, under a comment saying the wording matched
 *  what Liftoff and the Insights Manager are told. Nothing enforced that, and
 *  it stopped being true: `read_active_browser_session` was described here as
 *  the address alone long after it began returning the page. The definitions
 *  now come from `@liftoffos/browser-tools`, and this file supplies only the
 *  thing that is genuinely local — how a call reaches platform-backend. */
export const browserWorkforceTools: WorkforcePlanTool[] = BROWSER_TOOLS.map(
  t => browserTool(t.name, t.description, t.input_schema as WorkforcePlanTool['definition']['input_schema']),
);

// ── The Browser section ────────────────────────────────────────────────────

/** The two things a Browser state read needs from a turn. */
export interface BrowserStateContext {
  tenantId: string;
  threadId: string;
}

/**
 * The Browser section for this turn, rendered by platform-backend so the
 * three platform assistants read the browser in one phrasing: where it is,
 * who holds the wheel, and what the person did since the Chief AI Officer
 * last spoke (`sinceLastReply`, from this service's own history). Empty when
 * the thread has no browser and no record, and empty on any failure: a turn
 * never fails over its Browser section.
 */
export async function fetchBrowserState(
  ctx: BrowserStateContext,
  sinceLastReply: string | null,
): Promise<string> {
  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;
  try {
    const resp = await fetch(`${baseUrl}/api/internal/assistant-browser/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({ tenantId: ctx.tenantId, threadId: ctx.threadId, sinceLastReply }),
    });
    if (!resp.ok) {
      log.warn({ status: resp.status, threadId: ctx.threadId }, 'browser state: unexpected status from platform-backend');
      return '';
    }
    const body = await resp.json() as { block?: unknown };
    return typeof body.block === 'string' ? body.block : '';
  } catch (err) {
    log.warn({ error: (err as Error).message, threadId: ctx.threadId }, 'browser state: fetch to platform-backend failed');
    return '';
  }
}
