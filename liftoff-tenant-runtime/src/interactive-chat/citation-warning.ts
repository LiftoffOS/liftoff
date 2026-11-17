const OUTBOUND_MAIL_ACTIONS = new Set([
  'send_email', 'reply_email', 'forward_email',
  'create_draft', 'create_reply_draft',
]);

const URL_REGEX = /https?:\/\/[^\s)]+/;

/**
 * Returns { errorCode, outputSummary } when the conditions for a missing-citation
 * warning apply, otherwise { errorCode: undefined, outputSummary: undefined }.
 * Soft warning: errorCode is set, outcome stays 'success'.
 *
 * False-positive note: signature URLs / unsubscribe links in body satisfy the
 * regex. Acceptable for v1 — operator sees a flag, can dismiss. Tighten to
 * markdown-link pattern if real-world noise is high.
 */
export function evaluateCitationWarning(args: {
  actionType: string;
  toolInput: Record<string, unknown>;
  agentTemplateId: string | null;
}): { errorCode?: string; outputSummary?: string } {
  if (args.agentTemplateId !== 'customer-support-representative') return {};
  if (!OUTBOUND_MAIL_ACTIONS.has(args.actionType)) return {};
  const body = String((args.toolInput as { body?: unknown }).body ?? '');
  if (URL_REGEX.test(body)) return {};
  return {
    errorCode: 'MISSING_CITATION_URL',
    outputSummary: `Outbound support reply contains no URL. Body preview: ${body.slice(0, 200)}`,
  };
}

const OAUTH_REFRESH_PATTERNS = /OAuthRefresh|insufficient[_ ]scope|invalid_grant|reauthenticat/i;

export function detectErrorCode(rawError: unknown): string {
  const msg = String(rawError ?? '');
  if (OAUTH_REFRESH_PATTERNS.test(msg)) return 'OAUTH_REFRESH_REQUIRED';
  return 'TOOL_CALL_FAILED';
}
