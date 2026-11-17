// Persist the browser's last-known URL onto the thread's web_sessions row and
// push a SESSION_UPDATED so the dashboard pane can mirror it to localStorage.
//
// Anchor has no per-navigation webhook (its WebhookEventType catalog tops out
// at session.*/task.*/intervention.*/identity.*), so there is no push signal
// for navigation. Instead we capture the URL at the points where we already
// touch the session — goto, run_browser_task, read_active_browser_session,
// page-state — which covers the agent-driven and restore cases.
//
// What lands in the row is the SAFE projection (recordedUrl): the origin,
// path, resource ids, ordinary query parameters and fragment survive, and a
// URL credential, token, key or signature does not. No database row retains
// a tokenized URL; migration 423 removed the pre-deploy residue.

import { sanitizeBrowserText } from '@liftoffos/redact';
import * as repo from './repository';
import { emitBrowserSessionEvent } from './events';
import { recordedUrl } from './takeover-capture/route-template';
import { PAGE_TITLE_CAP, type BrowserSession } from './types';

export async function persistCurrentUrl(
  vendorSessionId: string,
  url: string | null | undefined,
  /** The page's title, when the caller read one; it is bounded and redacted
   *  here before it lands, and stamped with the URL's read time. */
  title?: string | null,
): Promise<BrowserSession | null> {
  if (!url) return null;
  const safeTitle = typeof title === 'string' ? sanitizeBrowserText(title, PAGE_TITLE_CAP).text : null;
  const updated = await repo.setCurrentUrl(vendorSessionId, recordedUrl(url).text, safeTitle);
  if (updated) {
    emitBrowserSessionEvent({ type: 'SESSION_UPDATED', session: updated, emittedAt: new Date() });
  }
  return updated;
}
