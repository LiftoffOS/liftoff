// Template-aware audit-log signal helpers — used by both the chat and
// autonomous SDK hook paths. Lives near the audit code (not the chat code)
// because every consumer is an audit-log writer.
//
// Design: the missing-citation warning is intentionally provenance-agnostic.
// It fires for ANY agent that meets the actual conditions of the rule:
//
//   1. The action is an outbound-mail variant (send_email, reply_email, …).
//   2. The agent has access to a knowledge base it could have cited
//      (corpus_search is exposed on this turn — derived from the SDK hook's
//      modelTools list).
//   3. At least one recipient (to / cc / bcc) is EXTERNAL — i.e. the recipient's
//      email domain is not in the agent's internalDomains set (derived from
//      its Gmail / Outlook sendAs binding config).
//   4. The body has no URL.
//
// Templates are not a part of this gate, by design. Templates are presentation
// sugar for filling in role / responsibilities / additionalContext — they
// don't grant capabilities, and a user can build an equivalent agent by hand
// through distillation. Tying audit behaviour to "did this come from our
// template" would silently exempt every manually-built customer-support agent
// and every HRBP-provisioned agent that didn't carry a templateId. So we gate
// on the agent's actual runtime configuration instead.
//
// When we cannot determine internal-vs-external (the agent has no sendAs
// configured, so `internalDomains` is empty), the warning REFUSES TO FIRE.
// Better silent than noisy.

/** Connector-tool function names (i.e. the suffix after the last `__`)
 *  that send mail out to a real recipient. Excludes pure search / read /
 *  draft-without-send variants because those can't leak a missing citation. */
const OUTBOUND_MAIL_ACTIONS: ReadonlySet<string> = new Set([
  'send_email',
  'reply_email',
  'forward_email',
  'create_draft',
  'create_reply_draft',
]);

const URL_REGEX = /https?:\/\/[^\s)]+/;
const EMAIL_REGEX = /[\w.+-]+@([\w.-]+)/g;

/**
 * Strip the connector-alias prefix from a tool action name. Tool gateway
 * names follow `<alias>__<fn>` (e.g. `my_gmail__send_email`). The hook's
 * `cleanToolName` only removes the `mcp__<server>__` envelope, so what
 * arrives here still carries the alias. Standard (non-connector) tools
 * have no `__` and pass through unchanged.
 *
 * Exported so tests can pin the behaviour directly.
 */
export function stripConnectorAlias(actionType: string): string {
  const idx = actionType.lastIndexOf('__');
  return idx === -1 ? actionType : actionType.slice(idx + 2);
}

/**
 * Pull every email-shaped value out of the recipient fields (`to`, `cc`,
 * `bcc`) and return the lower-cased domain set. Tolerates both string
 * and array shapes, "Name <addr>" wrappers, and stray commas.
 */
export function extractRecipientDomains(toolInput: Record<string, unknown>): string[] {
  const flat: string[] = [];
  for (const key of ['to', 'cc', 'bcc']) {
    const v = toolInput[key];
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string') flat.push(item);
    } else if (typeof v === 'string') {
      flat.push(v);
    }
  }
  const domains = new Set<string>();
  for (const field of flat) {
    let match: RegExpExecArray | null;
    EMAIL_REGEX.lastIndex = 0;
    while ((match = EMAIL_REGEX.exec(field)) !== null) {
      domains.add(match[1].toLowerCase());
    }
  }
  return Array.from(domains);
}

/**
 * Pull the domain part of every `sendAs` value across the agent's bound
 * integrations. Used to populate ExecutionContext.internalDomains, which the
 * citation-warning guardrail in tool-gateway/mcp-server.ts reads at dispatch.
 *
 * `sendAs` lives at `integration.config.sendAs` for Gmail and Outlook
 * bindings. If an agent has no sendAs configured, the returned array is
 * empty and the citation warning falls through to "silent" mode.
 */
export function deriveInternalDomains(
  integrations: ReadonlyArray<{ config?: Record<string, unknown> | undefined }> | undefined,
): string[] {
  if (!integrations) return [];
  const domains = new Set<string>();
  for (const integration of integrations) {
    const sendAs = integration.config?.sendAs;
    if (typeof sendAs !== 'string') continue;
    const at = sendAs.indexOf('@');
    if (at < 0 || at === sendAs.length - 1) continue;
    domains.add(sendAs.slice(at + 1).trim().toLowerCase());
  }
  return Array.from(domains);
}

/**
 * Returns `{ errorCode, outputSummary }` when every condition of the
 * missing-citation rule holds. Returns an empty object otherwise so the
 * caller can spread without overwriting other audit fields.
 *
 * Soft warning shape: `outcome` stays `'success'` at the call site; only
 * `errorCode` and `outputSummary` are set. The activity feed renders both.
 */
export function evaluateCitationWarning(args: {
  actionType: string;
  toolInput: Record<string, unknown>;
  /** True iff `corpus_search` was registered on this turn's tool list. */
  hasKnowledgeAccess: boolean;
  /** Domains the agent treats as internal (from sendAs). Empty = "unknown". */
  internalDomains: ReadonlyArray<string>;
}): { errorCode?: string; outputSummary?: string } {
  // Knowledge prerequisite: only flag when the agent had a base to cite.
  if (!args.hasKnowledgeAccess) return {};

  // Action prerequisite: only flag actions that actually send mail.
  if (!OUTBOUND_MAIL_ACTIONS.has(stripConnectorAlias(args.actionType))) return {};

  // External-recipient prerequisite. If we can't tell (no sendAs configured)
  // OR the recipient list is empty OR every recipient is internal, skip.
  // Better silent than noisy.
  if (args.internalDomains.length === 0) return {};
  const recipientDomains = extractRecipientDomains(args.toolInput);
  if (recipientDomains.length === 0) return {};
  const internalSet = new Set(args.internalDomains.map(d => d.toLowerCase()));
  const anyExternal = recipientDomains.some(d => !internalSet.has(d));
  if (!anyExternal) return {};

  // URL prerequisite: if the body has any URL, the agent cited something.
  const body = String((args.toolInput as { body?: unknown }).body ?? '');
  if (URL_REGEX.test(body)) return {};

  return {
    errorCode: 'MISSING_CITATION_URL',
    outputSummary: `Outbound reply to external recipient contains no URL. Body preview: ${body.slice(0, 200)}`,
  };
}

/**
 * Maps a tool-call failure error string to a stable error code surfaced on
 * the activity-feed audit row. Patterns cover the common ways the OAuth
 * providers we use (Google, Microsoft Graph) report a need to re-auth:
 *
 *   - Google: `invalid_grant`, `Token has been expired or revoked`
 *   - Google: `insufficient authentication scopes`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
 *   - Microsoft Graph: `InvalidAuthenticationToken`, `Insufficient privileges`
 *   - Microsoft Graph: `AADSTS65001` (consent), `AADSTS70008` (refresh expired)
 *   - Our own: `OAuthRefreshError`, `reauthenticate`, raw `403` / `401`
 *
 * Everything else collapses to `TOOL_CALL_FAILED` so the UI still has a
 * non-empty code to render.
 */
const OAUTH_REFRESH_PATTERNS: RegExp[] = [
  /OAuthRefresh/i,
  /invalid_grant/i,
  /reauthenticat/i,
  /insufficient[_ ](authentication[_ ])?scope/i,
  /insufficient[_ ]permission/i,
  /insufficient[_ ]privileges/i,
  /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i,
  /InvalidAuthenticationToken/i,
  /token (has been )?(expired|revoked)/i,
  /AADSTS(50076|50079|65001|70008|700082|700084|7000215)/i,
  /\b(401|403)\b/,
];

export function detectErrorCode(rawError: unknown): string {
  const msg = String(rawError ?? '');
  if (OAUTH_REFRESH_PATTERNS.some((re) => re.test(msg))) return 'OAUTH_REFRESH_REQUIRED';
  return 'TOOL_CALL_FAILED';
}
