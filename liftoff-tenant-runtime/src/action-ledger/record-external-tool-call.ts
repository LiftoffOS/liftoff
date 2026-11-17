// Remember what an agent did through a server that is not ours.
//
// The ledger is written inside `tool-gateway/service.ts`, so it records exactly
// the calls that pass through the gateway — and a vendor-hosted connector does
// not. `resolveVendorMcpServers` hands the engine a direct HTTP connection to
// the vendor's own MCP server with a bearer token, so a GitHub review goes
// straight to GitHub and this ledger never hears about it.
//
// The consequence is not subtle. `have_i_acted_on` reads this table, so an
// agent working through a vendor-hosted connector has no memory of its own
// actions: it reviews a pull request, the same head is redelivered, it asks
// whether it has already handled that commit, and is told no. Every time. It
// posts two reviews of one commit while the ledger stays empty, which is the
// behaviour any redelivery gets.
//
// WHY HERE AND NOT IN AN ADAPTER. The engine's event stream is the one place
// every tool call is visible whatever dispatched it — `claude-agent-sdk` reaches
// vendor servers through the SDK, the wire engines through `mcp-bridge`, codex
// and opencode over HTTP MCP — and a recorder written into any one of those
// covers that engine alone. Same reasoning that puts the provenance gate below
// the adapters rather than inside one.

import { deriveTarget } from './target-ref';
import { ActionLedgerService } from './service';
import { isOwnGatewayTool } from '../hitl-enforcement/tool-name-resolution';
import { toolResultFailure } from '../tool-gateway/mcp-result';
import { logger } from '../infrastructure/logging';

const SDK_MCP_PREFIX = 'mcp__';

/** `mcp__github-dd4c4689__pull_request_review_write`
 *   → `{ connector: 'github-dd4c4689', actionType: 'pull_request_review_write' }`
 *
 *  The connector is the server's own name — the ALIAS, `<type>-<first 8 of the
 *  instance uuid>` — exactly as the native path stores `manifest.alias`. That
 *  is the value that names an INSTANCE: a tenant with two custom MCP servers
 *  has two aliases and one type, and a ledger keyed by type could not say which
 *  of them an action went to.
 *
 *  Not stripped to the type here, and it was, on a premise that turned out to
 *  be false: "deriveTarget's rules are keyed by type". They are — and
 *  `deriveTarget` calls `connectorTypeFromAlias` on whatever it is handed, so
 *  the stripping was redundant for the one consumer it was done for, and lossy
 *  for the column it was written to. Two custom servers ledgered as one.
 *
 *  A name with no recognisable shape returns null rather than guessing:
 *  recording an action under the wrong connector is worse than not recording
 *  it, since the row then vouches for something that never happened there. */
export function parseVendorToolName(
  toolName: string,
): { connector: string; actionType: string } | null {
  if (!toolName.startsWith(SDK_MCP_PREFIX)) return null;
  const rest = toolName.slice(SDK_MCP_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const connector = rest.slice(0, sep);
  const actionType = rest.slice(sep + 2);
  if (!actionType) return null;
  return connector ? { connector, actionType } : null;
}

/**
 * What the event that woke this run was about, if it was woken by one.
 *
 * A run's inputData carries the normalized envelope — `{eventSource,
 * eventEntityType, eventData}` — and `eventData` is the vendor's own payload,
 * which for a GitHub delivery names the head sha. That is the version an action
 * in this run is at, and the tool payload does not carry it: a review-write is
 * `{method, owner, repo, pullNumber}` and nothing more, so a row derived from it
 * alone records WHAT was acted on and not WHICH REVISION of it.
 *
 * The consequence is precise. `have_i_acted_on` answers
 * `acted_version_unknown` — "you did something here, I cannot tell at which
 * commit" — and an agent given that answer reasonably reviews again. The
 * idempotency it is being asked for is version-scoped, so a versionless row
 * cannot deliver it.
 */
export function triggerTargetOf(
  inputData: Record<string, unknown> | undefined,
): { ref: string; version: string } | null {
  if (!inputData) return null;
  const source = inputData.eventSource;
  const data = inputData.eventData;
  if (typeof source !== 'string' || !data || typeof data !== 'object') return null;

  // The envelope spells the same facts differently from a tool payload, so it
  // is translated into `deriveTarget`'s language rather than `deriveTarget`
  // being taught webhook shapes. That direction matters: its key lists are read
  // against every tool call on every connector, and widening them to fit an
  // event would change how unrelated payloads resolve — `number` and `head` are
  // exactly the kind of generic names that would start matching things they do
  // not mean.
  //
  // Two differences, both narrow. `repository` carries the full `owner/repo`
  // slug here while the tool payloads it is read from carry a bare repo name
  // beside a separate `owner`; and the head sha arrives as `head`, which is not
  // one of the version keys.
  const payload: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  const repository = payload.repository;
  if (typeof repository === 'string' && repository.includes('/')) payload.full_name = repository;
  if (typeof payload.head === 'string' && payload.head_sha === undefined) payload.head_sha = payload.head;

  const derived = deriveTarget({ connector: source, actionType: '', payload });
  if (!derived.ref || !derived.version) return null;
  return { ref: derived.ref, version: derived.version };
}

/** What became of the row. `skipped` is a call this recorder does not keep
 *  (our own gateway's, an unparseable name, nothing identifiable named);
 *  `failed` is a row the database refused. A caller that marks a call as
 *  remembered may do so only on `recorded`. */
export type LedgerRecordOutcome = 'recorded' | 'skipped' | 'failed';

/**
 * Record one tool call that did not pass through the gateway.
 *
 * Never throws — the ledger is a record OF an action, not a gate on it: the
 * call has already happened by the time this runs, and failing here would turn
 * a completed review into a reported failure and invite a retry that reviews
 * twice. Exactly the reasoning `backstopLedger` states for the gateway's own
 * writes. But it SAYS when it failed: a caller that took a resolved promise
 * for a written row marked calls remembered that no row existed for.
 */
export async function recordExternalToolCall(args: {
  tenantId: string;
  agentId: string;
  toolName: string;
  callId: string;
  input: Record<string, unknown> | undefined;
  result: unknown;
  error?: string;
  traceId?: string;
  invocationId?: string;
  /** What the triggering event was about, from `triggerTargetOf`. */
  triggerTarget?: { ref: string; version: string } | null;
  ledger?: ActionLedgerService;
}): Promise<LedgerRecordOutcome> {
  // Our own gateway already wrote a row for this call; a second one here would
  // double-count the same action.
  if (isOwnGatewayTool(args.toolName)) return 'skipped';

  const parsed = parseVendorToolName(args.toolName);
  if (!parsed) return 'skipped';

  // The RESULT says whether the call failed; the event often does not. A gate
  // that denied the call answers `{ error }` without dispatching, and a tool
  // that ran and failed answers an `isError` envelope — both arrive on the
  // stream with no error field, and were written down as completed.
  const failure = args.error ?? toolResultFailure(args.result);

  try {
    const target = deriveTarget({
      connector: parsed.connector,
      actionType: parsed.actionType,
      payload: args.input ?? {},
    });
    // Nothing identifiable was named, so there is no question this row could
    // ever answer. A ledger of rows that cannot be looked up is worse than a
    // shorter one: it reports coverage it does not have.
    if (!target.ref) return 'skipped';

    // The run's own version, but ONLY for the thing the run was about.
    //
    // A run woken by PR 123 may also touch PR 456, and stamping 123's head sha
    // on an action against 456 would file a confident lie: the next redelivery
    // would read it as "already handled at that revision" for a revision that
    // was never examined. Matching on the ref is what keeps the inheritance
    // honest, and a payload that carried its own version always wins.
    const version = args.triggerTarget && args.triggerTarget.ref === target.ref
      ? target.version ?? args.triggerTarget.version
      : target.version;

    const ledger = args.ledger ?? new ActionLedgerService();
    const actionId = await ledger.recordIntent({
      tenantId: args.tenantId,
      agentId: args.agentId,
      workflowId: null,
      taskId: null,
      // Deterministic per call, so a redelivery that re-runs the same tool call
      // does not stack duplicate rows for one action.
      idempotencyKey: `${args.invocationId ?? 'no-invocation'}:${args.callId}`,
      connector: parsed.connector,
      entityType: 'default',
      actionType: parsed.actionType,
      targetRef: target.ref,
      targetVersion: version,
      traceId: args.traceId ?? '',
    });

    if (failure) await ledger.recordFailure(actionId, new Error(failure));
    else {
      // Wrapped as an ExecuteResult, because that is what `recordOutcome`
      // reads: it sets `status: result.success ? 'completed' : 'failed'`, and a
      // raw MCP tool result has no `success` field. Handing it one directly
      // marked every row FAILED — written, versioned, and skipped by the only
      // reader that matters, since `hasActedOn` counts
      // `status IN ('completed','succeeded')`. A row nobody counts is the same
      // as no row, arrived at more expensively.
      await ledger.recordOutcome(actionId, { success: true, data: args.result }, {
        connector: parsed.connector,
        actionType: parsed.actionType,
        entityType: 'default',
      });
    }
    return 'recorded';
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        toolName: args.toolName,
        agentId: args.agentId,
        invocationId: args.invocationId,
      },
      'external_tool_call_not_recorded',
    );
    return 'failed';
  }
}
