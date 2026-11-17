// Failure classification (migration 308, provider split in 352).
//
// Maps a caught error to a FailureClass so the rerun gate, the automatic retry,
// the stalled-run reconciler and diagnostics can act on WHY a run failed rather
// than only that it did. isRetryableFailureClass below is the single definition
// of which of those classes a retry can plausibly change.
//
// Ordering is the contract. The two classes that must NEVER be retried —
// provider_auth and provider_quota — are tested first, because a wrong retry
// there re-sends a rejected credential or spends against an empty balance, and
// getting one of them wrong is worse than leaving it 'unknown'.
//
// Status/name first, message-regex fallback: the `error` at the top-level
// error-salvage catch is the ORIGINAL thrown object (the FSM error is swallowed
// to preserve it), so `.status`/`.name` are available when the thrown error
// carries them, else message-only.
//
// Pure function. Refine the regexes against real invocations.error_message samples.

import type { FailureClass } from '../invocations/types';
import type { ProviderFailureInfo, ProviderFailureKind } from './adapter/provider-failure';
import { isRuntimeFaultName } from './adapter/provider-failure';

/** The structured taxonomy → the persisted failure classes (migration 355).
 *
 *  Maps onto 355's existing values; no new FailureClass member is introduced.
 *  `ArtifactResumeFailureClass` is a separate axis (artifact-resume decisions)
 *  and is untouched.
 *
 *  `unknown` maps to undefined on purpose: an engine that could not read a
 *  structured failure must fall through to the prose path rather than have its
 *  silence recorded as a classification. */
const KIND_TO_CLASS: Record<ProviderFailureKind, FailureClass | undefined> = {
  auth:               'provider_auth',
  quota:              'provider_quota',
  rate_limit:         'provider_capacity',
  overloaded:         'provider_capacity',
  server_error:       'provider_server_error',
  network:            'provider_network',
  invalid_request:    'validation',
  refusal:            'agent_declined',
  safety:             'agent_declined',
  malformed_response: 'provider_server_error',
  // Not a provider failure at all — a fault in our own adapter code. Its own
  // class so it is findable; never retried, because the same input reproduces
  // it exactly.
  adapter_internal:   'adapter_internal',
  unknown:            undefined,
};

/** A status code in prose, when the prose actually says it is one.
 *
 *  Two rules, both needed:
 *
 *  DIGIT boundaries, not word boundaries. `\b402\b` matches inside "402913
 *  tokens" — `\b` sits between a digit and a non-digit, and while "402913" has
 *  no such seam internally, the leading space gives one. Requiring a non-digit
 *  on BOTH sides is what stops a token count being read as a billing failure.
 *
 *  A CONTEXT marker, or the very start of the message. Digit boundaries alone
 *  still read "processed 401 records" as an auth failure — and misreading that
 *  as provider_auth is expensive, because auth is one of the two classes that
 *  must never be retried, so a run that a retry would have fixed dies instead.
 *  Vendors put the code either first ("401 Unauthorized") or right after a word
 *  that names it ("HTTP 429", "status: 503", "Error 402:", "returned 500"), so
 *  requiring one of those costs nothing real and removes the whole class of
 *  false positives.
 *
 *  The structured `.status` field remains the reliable path; this is the
 *  fallback for engines that only ever hand us a string. */
const STATUS_MARKER = '(?:HTTP|status(?:\\s*code)?|code|error|returned|response|responded(?:\\s+with)?|got|received)\\b[\\s:=]*';

function hasStatusCode(text: string, ...codes: number[]): boolean {
  return codes.some((c) => {
    const atStart = new RegExp(`^\\s*(?:\\[)?${c}(?![0-9])`, 'i');
    const afterMarker = new RegExp(`${STATUS_MARKER}${c}(?![0-9])`, 'i');
    return atStart.test(text) || afterMarker.test(text);
  });
}

export function classifyFailure(err: unknown, failure?: ProviderFailureInfo): FailureClass {
  const m = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number } | null | undefined)?.status;

  // Somebody ELSE's failure, wearing HTTP status codes that look like ours.
  //
  // A tool-gateway rejection, a governance denial or a connector's upstream all
  // carry their own status codes into the message, for example
  //   TOOL_ERROR {"error":"tool-gateway execute failed: HTTP 403
  //    {"error":"Governance authorize denied: decision=HITL_REQUIRED"}"}
  // which the status matcher below would otherwise read as provider_auth. The
  // outcome would be safe (auth is never retried) but the LABEL would send an
  // operator to re-authenticate a model provider that is working perfectly,
  // while the actual cause — a gate doing its job — went unnamed.
  //
  // Checked before any provider rule because the provider rules key on status
  // codes, and these messages are full of them.
  const isSomeoneElsesFailure =
    /TOOL_ERROR|tool-gateway|Governance authorize|HITL_REQUIRED|ToolExecutionError|\bMCP\b/i.test(m)
    // A very common tool failure, and without this it lands in 'unknown' —
    // which reads as "nobody has classified this yet" and hides a
    // failure whose cause is named in its own message.
    || /Tool call repeatedly failing/i.test(m)
    || /(?:no binding for|Permission denied:) connector/i.test(m);
  if (isSomeoneElsesFailure) return 'tool_error';

  // The STRUCTURED answer, when the engine had one. A provider naming its own
  // failure beats any amount of care applied to its message.
  //
  // Placed AFTER isSomeoneElsesFailure and nowhere else: a governance denial is
  // not a provider failure, and that stays true regardless of what the taxonomy
  // says about the status code the denial happened to carry.
  const fromKind = failure ? KIND_TO_CLASS[failure.kind] : undefined;
  if (fromKind) return fromKind;

  // A fault thrown by executing code, decided from the constructor rather than
  // the message. This runs even when no `failure` was supplied, because the
  // throw path (`adapter_invoke_threw`) calls this with the raw error and no
  // structured info — and without this a runtime TypeError on that path would
  // be labelled `unknown`.
  //
  // Checked BEFORE the regex block: a runtime fault's message is arbitrary
  // JavaScript prose, and the provider patterns below would happily match a
  // stray "connection" or "not found" inside a stack trace and blame a vendor
  // for our bug.
  //
  // The message is passed as well as the name because the name alone is not
  // decisive: undici throws `TypeError: fetch failed` for a genuine network
  // drop. That case is a provider being unreachable — retryable — and calling
  // it an adapter defect would both mislabel it and stop the retry that fixes
  // it. An existing test asserts exactly that, and caught this when the check
  // keyed on the constructor alone.
  if (isRuntimeFaultName(
    (err as { name?: unknown } | null | undefined)?.name as string | undefined,
    m,
  )) {
    return 'adapter_internal';
  }

  // ── Provider failures, most specific first ─────────────────────────────────
  // Auth and quota lead because they are the two that must NEVER be retried: a
  // retry re-sends the same rejected credential or spends against the same empty
  // balance. Getting these wrong is worse than leaving them 'unknown'.
  if (status === 401 || status === 403
    || hasStatusCode(m, 401, 403)
    || /invalid[_ ]api[_ ]key|authentication[_ ]error|unauthorized/i.test(m)) {
    return 'provider_auth';
  }
  // `billing` alone is deliberately NOT here. It appears in our own subsystem
  // names and messages ("billing publish failed", "billing service
  // unavailable"), and classifying one of those as provider_quota would mark a
  // retryable internal fault as permanently unretryable. Every phrase below
  // names the ACCOUNT being out, which is the only thing a top-up fixes.
  if (status === 402
    || hasStatusCode(m, 402)
    || /insufficient[_ ]quota|quota exceeded|exceeded your (?:current )?quota|credit balance (?:is )?too low|out of credits?|payment required|billing hard limit|billing_hard_limit/i.test(m)) {
    return 'provider_quota';
  }
  // The window is full. Separated from 'timeout' and 'unknown' because the
  // remediation is a FRESH session, not another attempt at the same one.
  if (/context[_ ](?:length|window)|maximum context|too many tokens|prompt is too long|exceeds? the (?:maximum )?context/i.test(m)) {
    return 'context_overflow';
  }
  if (status === 429 || status === 529
    || hasStatusCode(m, 429, 529)
    || /overloaded|rate.?limit|too many requests/i.test(m)) {
    return 'provider_capacity';
  }
  // The call never reached the PROVIDER, so no turn was consumed and the session
  // is still resumable.
  //
  // Two tiers, because the evidence is not equally strong. The errno-style
  // tokens only ever appear in a thrown socket error, so they stand alone. The
  // prose forms ("fetch failed", "network error") are what undici throws AND
  // what an agent writes when a CONNECTOR is down, for example
  // "Google Sheets integration is unreachable (all API calls return 'fetch
  // failed')". That is a tool failure wearing a network failure's words, and
  // calling it provider_network both mislabels it for an operator and marks it
  // retryable, so the run is re-attempted against an integration that is still
  // down. Naming an integration disqualifies the prose tier; the errno tier is
  // unaffected, since no agent narrates an ECONNRESET.
  const namesAnIntegration = /\b(integration|connector|MCP|spreadsheet|API calls?)\b/i.test(m);
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m)) {
    return 'provider_network';
  }
  if (!namesAnIntegration && /network error|fetch failed|TLS handshake|certificate/i.test(m)) {
    return 'provider_network';
  }

  if ((err as Error)?.name === 'AbortError' || /wall_clock_exceeded|turn.?timeout|timed out/i.test(m)) return 'timeout';

  // Keyed on the STRUCTURED status, not on a 5xx appearing in prose. A bare
  // "502" in a message is far more often a connector's upstream than our model
  // provider's, and the tool_error rule below has owned that shape since 308 —
  // stealing it here would relabel every connector outage as a provider one.
  if (status === 500 || status === 502 || status === 503 || status === 504
    || /internal server error|bad gateway|service unavailable|gateway timeout|api[_ ]error/i.test(m)) {
    return 'provider_server_error';
  }

  if (/\b5\d\d\b/.test(m) || /ToolExecutionError|connector .*failed/i.test(m)) return 'tool_error';
  if (/schema|zod|invalid (?:input|argument)/i.test(m)) return 'validation';
  if (/declined|no action|nothing to do/i.test(m)) return 'agent_declined';
  return 'unknown';
}

/** The classes where running the same work again has a real chance of a
 *  different answer.
 *
 *  Deliberately narrow. Everything else is either deterministic (validation, a
 *  broken tool), deliberate (task_failed, recovery_declined, agent_declined), a
 *  budget decision (limit_reached), or fixed by a person and not by a retry
 *  (provider_auth, provider_quota, admission_denied, lifecycle_not_active).
 *  agent_busy is excluded too: the agent is working, and hammering the lock does
 *  not make it finish sooner — that path already has its own defer-and-requeue.
 *
 *  context_overflow is in the set with a caveat the CALLER owns: it retries only
 *  on a FRESH session, because resuming the saturated one reproduces it exactly.
 *
 *  Exported so both the autonomous retry (cloud-tasks-handler) and the control
 *  plane (via the chat SSE `retryable` field) read ONE definition instead of
 *  each keeping its own copy of the taxonomy. */
const RETRYABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'provider_capacity',
  'provider_server_error',
  'provider_network',
  'context_overflow',
]);

export function isRetryableFailureClass(failureClass?: FailureClass | null): boolean {
  return !!failureClass && RETRYABLE_FAILURE_CLASSES.has(failureClass);
}

/**
 * What to SAY to the person when a chat turn dies at the engine layer.
 *
 * `classifyFailure` above exists for machines — the rerun gate, the stalled-run
 * reconciler, diagnostics. Nothing ever turned it into words, so the chat error
 * frame carried `execResult.error` verbatim: a vendor SDK message, a Postgres
 * error, whatever was thrown. The web client has a guard for that, but it is a
 * single prefix test (`/^chat turn/i`), so anything else reaches the user as-is.
 *
 * Classifying here rather than sniffing prose there is the direction the client
 * comment already assumed ("the platform-backend now sends user-facing copy
 * directly"). One sentence per class, no internal vocabulary, no apology, and
 * no instruction the user cannot act on.
 *
 * Deliberately NOT parameterised by connector or vendor: naming the failing
 * third party requires knowing it was the third party's fault, and at this
 * layer we only know the run died. `tool_error` therefore says a tool failed
 * without asserting which — the tool-level envelope already carries the precise
 * recovery text on the paths where it is actually known.
 */
const FAILURE_COPY: Record<FailureClass, string> = {
  transient_infra:
    'The AI service is busy right now. Please try again in a moment.',
  timeout:
    'That took longer than expected and was stopped. Try again, or break the request into smaller steps.',
  tool_error:
    'One of the connected tools did not respond. Please try again, and check your connections if it keeps happening.',
  validation:
    'That request could not be processed as written. Try rephrasing it.',
  agent_declined:
    'There was nothing to do for that request.',
  stalled:
    'That run stopped responding and was ended. Please try again.',
  // The work was going fine; there was simply not enough room left to finish
  // it. "Try again" alone would repeat the same ending, so say what would
  // change the outcome.
  limit_reached:
    'That run reached its limit before finishing. Ask for a smaller piece of the work, or raise the limit for this team.',
  task_failed:
    'That could not be completed. Please try again, or rephrase the request.',
  // The recovery advisor deliberately ended the run, so "try again" would be
  // advice to repeat something we already decided not to continue.
  recovery_declined:
    'That could not be completed. Someone may need to look at how this team member is set up.',
  unknown:
    'Something went wrong on our side. Please try again.',
  // Deliberately does NOT say "try again". A runtime fault reproduces on the
  // same input, so inviting a retry is inviting the same ending — the one thing
  // this copy is not allowed to do. It says the outcome and who owns it, and
  // stops there, because there is nothing the person can do about our bug.
  adapter_internal:
    'Something went wrong on our side while handling that. It has been recorded for us to fix.',
  // Provider failures. Each says what would change the outcome, because "try
  // again" is wrong advice for four of the six.
  provider_capacity:
    'The AI service is busy right now. Please try again in a moment.',
  provider_server_error:
    'The AI service had a problem on its side. Please try again in a moment.',
  provider_network:
    'The connection to the AI service dropped. Please try again.',
  provider_auth:
    'The AI service rejected our credentials. Someone with admin access needs to reconnect it.',
  provider_quota:
    'This workspace is out of AI service credit. Someone with billing access needs to top it up.',
  context_overflow:
    'This conversation is too long to continue. Start a new one, and say what you need carried over.',
  // Pre-invocation guards. Result-level only, but a chat turn can surface any of
  // the three, so all three need words a person can act on.
  admission_denied:
    'This team member is not cleared to run right now. Check the workspace plan and status.',
  agent_busy:
    'This team member is already working on something. Please try again once it finishes.',
  lifecycle_not_active:
    'This team member is paused. Resume it from the dashboard to run again.',
};

/**
 * User-facing sentence for a failed run. Always returns copy — an unmapped
 * class falls back to the `unknown` sentence rather than to the raw error,
 * because "always safe to display" is the entire point of this function.
 */
export function failureMessageForUser(failureClass: FailureClass): string {
  return FAILURE_COPY[failureClass] ?? FAILURE_COPY.unknown;
}
