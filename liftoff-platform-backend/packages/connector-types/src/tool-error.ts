// Canonical tool-error taxonomy. Shared by connector-service (classifies at
// origin), tenant-runtime (maps at ingress, surfaces to model + recovery), and
// composio-overlays (translateError produces these codes). ONE source of truth.

export const TOOL_ERROR_CODES = [
  'auth_expired',
  'permission_denied',
  'not_found',
  'invalid_arguments',
  'rate_limited',
  'vendor_unavailable',
  'internal_error',
  // A PLATFORM gate refused the call before it reached any vendor: the tenant
  // is suspended (operationally or for billing), execution is not authorised,
  // the agent is not ACTIVE, or a kill switch is on. It sits in this taxonomy
  // because the taxonomy answers "why did this tool call fail", and a policy
  // refusal is one of the answers — `internal_error` is not. Without it the
  // message heuristic classified every admission denial as an internal error
  // and the recovery LLM read a policy decision as an infrastructure outage.
  'admission_denied',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** retryable is a pure function of code so the two never drift. */
const RETRYABLE: Record<ToolErrorCode, boolean> = {
  auth_expired: false,
  permission_denied: false,
  not_found: false,
  invalid_arguments: false,
  rate_limited: true,
  vendor_unavailable: true,
  internal_error: false,
  // A policy gate returns the same answer to an identical call, always.
  admission_denied: false,
};

export function isRetryable(code: ToolErrorCode): boolean {
  return RETRYABLE[code];
}

export function isToolErrorCode(v: unknown): v is ToolErrorCode {
  return typeof v === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(v);
}

/** The wire/return contract every failed tool call carries. */
export interface ToolErrorContract {
  code: ToolErrorCode;
  retryable: boolean;
  /** Milliseconds to wait before a retry when retryable. Optional. */
  retryAfterMs?: number;
  /** Actionable, model-facing next step (Arcade "recovery guide"). */
  recovery: string;
  /** Raw vendor message — kept for logs/audit, still shown to the model as `message`. */
  message: string;
}

export interface RecoveryContext {
  connectorType?: string;
  connectorId?: string;
  toolName?: string;
}

/** Actionable recovery text per code. Names the concrete next action/tool.
 *
 *  Every code names the connector, because an agent that cannot tell WHICH
 *  integration failed will guess, and a confident wrong guess is worse than an
 *  unexplained failure.
 *
 *  `auth_expired` and `permission_denied` always did. The other five did not,
 *  and a vendor message rarely supplies it either — vendors identify their own
 *  objects and know nothing about ours. Composio's 404 reads
 *
 *      Connected account "ca_…" not found
 *
 *  which classifies to `not_found`, so the pair the model saw was that opaque id
 *  plus "The target does not exist". Neither said Slack.
 *
 *  An agent reading exactly that off a Slack send can conclude GitHub is broken
 *  and keep asking a human to reconnect a GitHub account that does not exist —
 *  though GitHub is healthy and is not even a Composio connector. It is
 *  believable because it quotes a real id and a real error.
 *
 *  `admission_denied` is the deliberate exception; see its case.
 */
export function recoveryFor(code: ToolErrorCode, ctx: RecoveryContext = {}): string {
  const who = ctx.connectorType ? `the ${ctx.connectorType} connector` : 'this connector';
  switch (code) {
    case 'auth_expired':
      return `${who} needs to be reconnected. Ask the user to reconnect it on the Connections page, then retry. Do not retry before reconnection.`;
    case 'permission_denied':
      return `${who} is missing a required permission/scope for this action. This will not succeed on retry; try a different tool or ask the user to grant access.`;
    case 'not_found':
      return `${who} reports that the target does not exist. Re-check the id/reference (list/search first to resolve the correct one) before calling again. Any account or resource id in the message belongs to ${who} — do not attribute it to a different integration.`;
    case 'invalid_arguments':
      return `${who} rejected the arguments. Fix them per the tool schema and call again; do not repeat the same arguments.`;
    case 'rate_limited':
      return `${who} is rate limiting — this is temporary. Wait${''}, then retry the same call unchanged.`;
    case 'vendor_unavailable':
      return `The provider behind ${who} is temporarily unavailable. Retry the same call shortly; if it keeps failing, move on and report it.`;
    case 'internal_error':
      // `internal_error` is retryable:false in the table above. Telling the
      // model to "retry once" contradicted the machine-readable field it
      // ships beside, and the model reads the prose.
      return `An internal error occurred calling ${who}. Repeating the identical call is not expected to help — change the approach, or report it and move on.`;
    case 'admission_denied':
      // Deliberately does NOT name the connector: nothing about the connector
      // is wrong. The concrete policy reason is carried on the contract's
      // `message`, and callers that have it should pass a reason-first recovery
      // (see admissionDeniedRecovery in the tenant runtime) rather than falling
      // back to this generic form.
      return `This was blocked by a platform policy — an entitlement, suspension or kill switch — not by the tool or the provider. Retrying the same call will produce the same answer. Report the reason to the user or escalate.`;
  }
}

/**
 * Heuristic classifier for errors that arrive WITHOUT a pre-computed code
 * (native connector clients, generic thrown Errors). Ordered most→least
 * specific. Returns internal_error when nothing matches.
 *
 * NOTE: composio failures do NOT go through here — they already carry a code
 * from defaultComposioErrorMap. This is the native/unknown fallback only.
 */
export function classifyError(input: {
  message?: string;
  httpStatus?: number;
  /** connect-rpc Code as a number, when the error is a ConnectError. */
  connectCode?: number;
}): ToolErrorCode {
  // gRPC/Connect Code is authoritative when the error is a ConnectError.
  // Codes not mapped here fall through to the message/status heuristics
  // below (which default to internal_error).
  switch (input.connectCode) {
    case 9: return 'auth_expired';        // FailedPrecondition
    case 7: return 'permission_denied';   // PermissionDenied
    case 5: return 'not_found';           // NotFound
    case 3: return 'invalid_arguments';   // InvalidArgument
    case 14: return 'vendor_unavailable'; // Unavailable
  }
  const msg = (input.message ?? '').toLowerCase();
  const s = input.httpStatus;
  if (s === 401 || /\b401\b|unauthor|invalid[_ ]?token|token expired|reauth/.test(msg)) return 'auth_expired';
  if (s === 403 || /\b403\b|forbidden|permission denied|insufficient scope/.test(msg)) return 'permission_denied';
  if (s === 404 || /\b404\b|not found|no such|does not exist/.test(msg)) return 'not_found';
  if (s === 429 || /\b429\b|rate.?limit|too many requests|quota exceeded/.test(msg)) return 'rate_limited';
  // The call is malformed FOR THIS TARGET, and the vendor said how to fix it.
  //
  // These fell through to internal_error, whose recovery told the agent to
  // "retry once" — so it repeated the identical call, failed identically, and
  // abandoned the step. For example, a reviewing agent could reach the review
  // write on a pull request and stop there on two of these:
  //
  //   Read: File content (28868 tokens) exceeds maximum allowed tokens (25000).
  //         Use offset and limit parameters to read specific portions...
  //   add_comment_to_pending_review: The line number doesn't exist in the pull
  //         request diff / the side (LEFT/RIGHT) is invalid for that line
  //
  // Both name the remedy in the message, and both are argument problems: the
  // resource exists, the ARGUMENTS do not fit it. Classified here they get
  // invalid_arguments, whose recovery is "fix them per the tool schema and call
  // again; do not repeat the same arguments" — which is the true instruction
  // instead of its opposite.
  //
  // Deliberately AFTER rate_limited so "quota exceeded" stays a rate limit, and
  // after not_found so a genuinely missing resource is not relabelled: the
  // distinction is whether the TARGET is absent or the ARGUMENTS are wrong.
  if (
    /exceeds?\s+(?:the\s+)?maximum|maximum allowed tokens|exceeds \d+ tokens|content too large|response too large|use offset and limit|out of range|line number (?:does\s?n[o']?t|doesn't) exist|not (?:part of|in) the (?:pull request )?diff|invalid (?:position|line|side)/.test(msg)
  ) return 'invalid_arguments';
  if (s === 400 || s === 422 || /\b400\b|\b422\b|invalid (argument|parameter|request)|bad request|validation/.test(msg)) return 'invalid_arguments';
  if ((s !== undefined && s >= 500) || /\b5\d\d\b|unavailable|timeout|timed out|econnreset|econnrefused|etimedout|socket hang up/.test(msg)) return 'vendor_unavailable';
  return 'internal_error';
}

/** Build the full contract from a code (+ optional overrides). */
export function toolError(
  code: ToolErrorCode,
  message: string,
  ctx: RecoveryContext = {},
  retryAfterMs?: number,
): ToolErrorContract {
  return { code, retryable: isRetryable(code), retryAfterMs, recovery: recoveryFor(code, ctx), message };
}
