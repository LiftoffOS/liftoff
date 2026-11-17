// The persistence-boundary pass for a browser tool call.
//
// Invocation evidence (`invocations.tool_calls`), the interactive-chat
// persistence path and browser-specific audit or diagnostic logs all keep
// the tool call as it was made: the raw `prompt`, the raw `url`. That is
// where a protected value a malformed caller put in a task prompt, or a
// token in a navigation address, would otherwise be written durably even
// though the handler refused or sanitized it. This helper replaces a browser
// call's prompt and URL arguments with their safe projections and passes the
// output through the bounded result walk before any of that is written. The
// existing trajectory sink remains the final broad PII scrubber; this is the
// browser-specific pass in front of it.

import { sanitizeBrowserText } from '@liftoffos/redact';
import { recordedUrl } from '../browser-sessions/takeover-capture/route-template';
import { sanitizeResultTree } from '../integrations/web-fetch/result-sanitizer';

/** Every browser tool a call can name. A tool listed here has its
 *  arguments replaced; the enumerating test holds this list to the catalog. */
export const BROWSER_TOOL_NAMES = [
  'run_browser_task',
  'check_browser_task',
  'navigate_browser_session',
  'start_browser_session',
  'read_active_browser_session',
  'save_active_browser_page_as_pdf',
  'screenshot_browser_session',
  'list_browser_downloads',
  'fetch_browser_download',
  'check_browser_intervention_pending',
  'get_browser_session_stats',
  // The record, the controls and the one-control actions, and the request
  // for the person to take over.
  'read_browser_session_activity',
  'read_browser_session_controls',
  'act_in_browser_session',
  'ask_person_to_take_over_browser_session',
] as const;

const BROWSER_TOOL_SET: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);

/** The argument keys that carry a natural-language instruction or a URL. */
const PROMPT_KEYS = ['prompt', 'task', 'instruction', 'text', 'value', 'reason'] as const;
const URL_KEYS = ['url', 'initial_url', 'starting_url'] as const;

export function isBrowserToolName(name: string): boolean {
  return BROWSER_TOOL_SET.has(name);
}

/** A browser tool call as it may be persisted: safe arguments, safe output,
 *  and explicit markers for what changed. Any other call is returned as it
 *  came. */
export function safeBrowserToolCallForPersistence<T extends { name: string; input: Record<string, unknown>; output: unknown }>(
  call: T,
): T {
  if (!isBrowserToolName(call.name)) return call;
  const input: Record<string, unknown> = { ...call.input };
  for (const key of PROMPT_KEYS) {
    if (typeof input[key] !== 'string') continue;
    const safe = sanitizeBrowserText(input[key] as string);
    input[key] = safe.text;
    if (safe.protectedDataOmitted) input[`${key}ProtectedDataOmitted`] = true;
    if (safe.truncated) input[`${key}Truncated`] = true;
  }
  for (const key of URL_KEYS) {
    if (typeof input[key] !== 'string') continue;
    const safe = recordedUrl(input[key] as string);
    input[key] = safe.text;
    if (safe.protectedDataOmitted) input[`${key}ProtectedDataOmitted`] = true;
    if (safe.truncated) input[`${key}Truncated`] = true;
  }
  const output = call.output === undefined ? undefined : sanitizeResultTree(call.output).value;
  return { ...call, input, output };
}
