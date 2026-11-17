// The one navigation every pane surface makes, recorded once.
//
// A navigation happened in two places — the Goto RPC a platform assistant
// calls, and the team's `navigate_browser_session` tool — each doing
// `gotoUrl` then `persistCurrentUrl` on its own. Folded here so there is ONE
// call site: after navigating it reads the page's ACTUAL final URL and title
// (redirects, consent interstitials and login walls all change it), persists
// the safe projection, records the call as browser activity under the
// caller's id, and returns the safe destination with its omission and
// truncation flags. The raw requested URL is used transiently for the
// navigation itself (a signed, reset or magic link must still open) and only
// its safe projection crosses the result, the log, the event or the row.
//
// Both success and failure after session resolution are recorded once, and a
// failure is recorded BEFORE the helper rethrows: `gotoUrl` throws today and
// keeps throwing, so the RPC's failure still surfaces as a ConnectError, with
// the row already written under an id the caller knows.

import { randomUUID } from 'node:crypto';
import { sanitizeBrowserText } from '@liftoffos/redact';
import * as vendorOps from './session-vendor-proxy';
import { persistCurrentUrl } from './current-url';
import { recordBrowserActivity } from './activity-repository';
import { recordedUrl } from './takeover-capture/route-template';
import { PAGE_TITLE_CAP, type BrowserSession } from './types';

export { PAGE_TITLE_CAP };

export interface NavigateAndRecordInput {
  tenantId: string;
  session: BrowserSession;
  /** The raw requested URL, already validated as absolute http(s) by the
   *  caller's public-URL guard. */
  url: string;
  /** The caller's activity id; minted here when the caller has none. */
  activityId?: string;
}

export interface NavigateAndRecordResult {
  /** The safe projection of where the browser actually landed. */
  finalUrl: string;
  finalUrlTruncated: boolean;
  finalUrlProtectedDataOmitted: boolean;
  title: string;
  titleTruncated: boolean;
  titleProtectedDataOmitted: boolean;
  /** The safe projection of what was asked for. */
  requestedUrl: string;
  requestedUrlProtectedDataOmitted: boolean;
  /** The id the row was written under; null when the row could not be
   *  written (the navigation still happened). */
  activityId: string | null;
  /** The session row after the URL was persisted, when it was. */
  session: BrowserSession | null;
}

export async function navigateAndRecord(input: NavigateAndRecordInput): Promise<NavigateAndRecordResult> {
  const { tenantId, session } = input;
  const activityId = input.activityId || randomUUID();
  const requested = recordedUrl(input.url);
  // A run-scoped session (an unattended run's sandbox browser) has no thread,
  // no pane and no takeover: its navigation is not pane work and is not
  // recorded. The navigation itself happens all the same.
  const threadId = session.threadId;
  const record = async (outcome: string, personTookOver = false): Promise<string | null> => (threadId ? recordBrowserActivity({
    id: activityId,
    tenantId,
    threadId,
    sessionId: session.id,
    tool: 'navigate_browser_session',
    instruction: requested.text,
    instructionTruncated: requested.truncated,
    instructionProtectedDataOmitted: requested.protectedDataOmitted,
    outcome,
    personTookOver,
    steps: null,
    captureGap: false,
    gapReason: null,
    stepsTruncated: false,
  }) : null);
  try {
    await vendorOps.gotoUrl(session.vendor, session.vendorSessionId, tenantId, input.url);
  } catch (err) {
    // Recorded under the caller's id BEFORE the rethrow, so the RPC's
    // ConnectError and the row agree.
    const failure = sanitizeBrowserText(`could not open ${requested.text}: ${(err as Error).message}`);
    await record(failure.text);
    throw err;
  }
  let page: { url: string; title?: string };
  try {
    page = await vendorOps.getActivePage(session.vendor, session.vendorSessionId, tenantId);
  } catch (err) {
    const failure = sanitizeBrowserText(`opened ${requested.text}; the page could not be read: ${(err as Error).message}`);
    await record(failure.text);
    throw err;
  }
  const finalUrl = recordedUrl(page.url ?? '');
  const title = sanitizeBrowserText(page.title ?? '', PAGE_TITLE_CAP);
  const updated = await persistCurrentUrl(session.vendorSessionId, page.url, page.title ?? null).catch(() => null);
  const recorded = await record(`opened ${finalUrl.text}; title: ${title.text}`);
  return {
    finalUrl: finalUrl.text,
    finalUrlTruncated: finalUrl.truncated,
    finalUrlProtectedDataOmitted: finalUrl.protectedDataOmitted,
    title: title.text,
    titleTruncated: title.truncated,
    titleProtectedDataOmitted: title.protectedDataOmitted,
    requestedUrl: requested.text,
    requestedUrlProtectedDataOmitted: requested.protectedDataOmitted,
    activityId: recorded,
    session: updated,
  };
}
