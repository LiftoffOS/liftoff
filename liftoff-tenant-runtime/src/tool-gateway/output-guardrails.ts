import { recordHostDelivered } from './host-delivered';
import { projectDocumentText } from './document-text-projection';
import { getToolSchema, catalogTypeFor, getCustomApiToolSchema, CUSTOM_API_CONNECTOR_TYPE } from '../connectors/tool-schema-cache';
import { log } from '../infrastructure/logging';
export class GuardrailBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailBlockError';
  }
}

/** What the gateway knows about the call, for a guardrail that needs to say
 *  something back rather than only reshape the output. */
export interface GuardrailContext {
  invocationId?: string;
  /** The connector the call went to — an instance alias (`google_drive-8fd9fc68`)
   *  or a type. A guardrail that reads the tool's declaration needs it: the
   *  gateway names a call by its bare action (`find_file`), and an action alone
   *  keys no schema. */
  connector?: string;
  /** The agent the call ran for. The staged-write record binds a batch to it. */
  agentId?: string;
}

export interface ToolOutputGuardrail {
  name: string;
  check(
    toolName: string,
    input: unknown,
    output: unknown,
    tenantId: string,
    ctx?: GuardrailContext,
  ): Promise<unknown>;
}

// Patterns that look like credentials / API keys in tool output, each with the
// KIND it matched.
//
// WHY THE KIND IS PART OF THE REDACTION. A bare `[REDACTED]` removes the
// credential and the finding with it. A code-review agent's most valuable single
// act is telling you a commit adds a secret, and it reads the diff through this
// filter: `pull_request_read { method: get_diff }` returns a unified diff as
// text, every string of which is scrubbed. Replacing `AKIA…` with `[REDACTED]`
// leaves the reviewer looking at a line it cannot characterise, so the review
// says nothing and the secret ships.
//
// `[REDACTED:aws-access-key-id]` keeps both properties: the value never reaches
// the model, and the model can still report "this commit adds an AWS access key
// id at line 40". The kind is a fixed label from this table, never any part of
// the matched text, so nothing about the secret itself survives the marker.
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'openai-api-key',    pattern: /sk-[a-zA-Z0-9]{32,}/g },
  { kind: 'bearer-token',      pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
  { kind: 'api-key',           pattern: /(?:api[_-]?key|apikey|api[_-]?secret|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?([a-zA-Z0-9._\-/+]{20,})["']?/gi },
  { kind: 'password',          pattern: /(?:password|passwd|secret)\s*[:=]\s*["']([^"'\s]{8,})["']/gi },
  { kind: 'private-key-block', pattern: /-----BEGIN (?:RSA|EC|PRIVATE|OPENSSH) PRIVATE KEY-----/g },
  { kind: 'github-token',      pattern: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/g },
  { kind: 'slack-token',       pattern: /xox[bpoa]-[a-zA-Z0-9-]+/g },
  { kind: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
];

function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const { kind, pattern } of SECRET_PATTERNS) {
      result = result.replace(pattern, `[REDACTED:${kind}]`);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubSecrets(v)])
    );
  }
  return value;
}

const secretScrubGuardrail: ToolOutputGuardrail = {
  name: 'secret-scrub',
  async check(_toolName: string, _input: unknown, output: unknown, _tenantId: string): Promise<unknown> {
    return scrubSecrets(output);
  },
};

/**
 * Host-only result fields: values that reach the SURFACE but not the model.
 *
 * Today every byte a connector returns enters model context, and the only
 * escape removes content entirely. Some values want the opposite treatment: a
 * signed URL, a payment link, a one-time token, PII the surface may render to
 * its owner. The person needs them; the model does not, and putting them in
 * context is how a signed URL ends up quoted into a summary that is then stored,
 * logged and learned from.
 *
 * ROLLOUT STEP (a) ONLY, and the boundary is deliberate. This strips fields a
 * connector declares `egressOnly` AND that are secret-shaped or categorised
 * `sensitive` — values no user ever needed to see. It does NOT yet move
 * user-facing values like download links, because stripping a link before the
 * surface can render the side-channel event would silently take the link away.
 * That is step (c), and it comes strictly after the renderer ships.
 *
 * The model-visible result keeps a placeholder rather than losing the key. A
 * disappeared field reads to a model as a tool that returned nothing useful,
 * and it retries; `[delivered to the surface]` tells it the value exists, went
 * somewhere, and is not its to handle.
 *
 * Lands on BOTH dispatch paths automatically, because `applyOutputGuardrails`
 * is what the serial path and the batch fast path share — the same reason the
 * provenance recorder lives where it does.
 */
export const EGRESS_ONLY_PLACEHOLDER = '[delivered to the surface]';

/**
 * Whether a value may be lifted at step (a).
 *
 * Two ways in, and one of them almost never fires: `secret-scrub` runs BEFORE
 * this guardrail and has already replaced a secret-shaped value with
 * `[REDACTED:kind]`, which is no longer secret-shaped. That ordering is
 * deliberate — running this first would put a real credential on the side
 * channel, and step (a) is explicitly about values no user ever needed to see.
 *
 * So the load-bearing branch is `sensitive`: a field the connector declared
 * egressOnly on a tool it categorised sensitive, whatever the value looks like.
 * The secret-shaped test is kept as a floor for a value the scrubber's patterns
 * do not recognise but a connector has declared anyway.
 *
 * The third branch is step (c), and it is why the first two were narrow.
 *
 * A connector declaring `egressOnly` on an ordinary field — a download link, a
 * payment URL — is saying "this is for the person". Honouring that had nowhere
 * to put the value, so the declaration was ignored for anything that was not
 * already a secret: taking the link out of the model's copy would have taken it
 * out of existence, and the person would read "here is your file" with no file,
 * which is indistinguishable from a tool that failed.
 *
 * There is now somewhere to put it, so the declaration is honoured — but only
 * WHEN IT CAN BE DELIVERED. `canDeliver` is false for a call with no invocation
 * to carry the side channel, and on that path the old reasoning still holds
 * exactly: a value nobody can receive is better left where it is than removed
 * from both copies. The safety property survives step (c) rather than being
 * traded for it.
 */
function isStepAStrippable(value: unknown, sensitive: boolean, canDeliver: boolean): boolean {
  if (sensitive) return true;
  // Secret-shaped: lifted whether or not anyone is listening. Nobody needed to
  // see it, so losing it costs nothing and leaving it in context costs plenty.
  // Reuses the same patterns the scrubber matches on, so "secret-shaped" means
  // one thing in this file rather than two.
  if (typeof value === 'string' && scrubSecrets(value) !== value) return true;
  return canDeliver;
}

/** Read a dot path with `[]` meaning every element, returning the containers
 *  and keys so the value can be replaced in place. */
function eachAtPath(
  root: unknown,
  path: string,
  visit: (container: Record<string, unknown>, key: string) => void,
): void {
  const parts = path.split('.');
  const walk = (node: unknown, i: number): void => {
    if (node === null || node === undefined) return;
    const part = parts[i];
    if (part === undefined) return;
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    if (typeof node !== 'object') return;
    const container = node as Record<string, unknown>;
    if (i === parts.length - 1 && !isArray) {
      if (key in container) visit(container, key);
      return;
    }
    const next = container[key];
    if (isArray && Array.isArray(next)) {
      for (const item of next) walk(item, i + 1);
      return;
    }
    walk(next, i + 1);
  };
  walk(root, 0);
}

export interface EgressOnlyExtraction {
  /** The result as the model may see it. */
  modelVisible: unknown;
  /** What was lifted off, keyed by path, for the side-channel event. */
  sideChannel: Record<string, unknown>;
}

/**
 * Lift `egressOnly` paths off a result.
 *
 * Pure and exported so the guardrail, the side-channel emitter and the tests
 * all agree on what was taken — a second implementation would be a second
 * answer to "did the model see this".
 */
export function extractEgressOnly(
  output: unknown,
  egressOnly: readonly string[] | undefined,
  opts?: { sensitive?: boolean; canDeliver?: boolean },
): EgressOnlyExtraction {
  if (!egressOnly || egressOnly.length === 0) return { modelVisible: output, sideChannel: {} };
  const clone = JSON.parse(JSON.stringify(output ?? null)) as unknown;
  const sideChannel: Record<string, unknown> = {};

  for (const path of egressOnly) {
    eachAtPath(clone, path, (container, key) => {
      const value = container[key];
      if (!isStepAStrippable(value, opts?.sensitive === true, opts?.canDeliver === true)) return;
      sideChannel[path] = value;
      container[key] = EGRESS_ONLY_PLACEHOLDER;
    });
  }
  return { modelVisible: clone, sideChannel };
}

/**
 * The egress guardrail itself.
 *
 * A builtin rather than a call site, so it lands on BOTH dispatch paths
 * automatically — `applyOutputGuardrails` is what the serial path and the batch
 * fast path share, which is the same reason the provenance recorder lives where
 * it does. A version of this bolted onto `execute()` would miss every batched
 * call, and poll-then-act batches its reads.
 *
 * The declaration is read from the tool schema, so a connector opts in by
 * saying `egressOnly` on the function rather than by anything here knowing the
 * connector's name.
 */
const egressOnlyGuardrail: ToolOutputGuardrail = {
  name: 'egress-only',
  async check(
    toolName: string,
    _input: unknown,
    output: unknown,
    tenantId: string,
    ctx?: GuardrailContext,
  ): Promise<unknown> {
    // The gateway hands this the bare action and the connector on the
    // context; a caller naming the tool `<type>__<action>` carries the type in
    // the name. Both resolve to the catalog's key. Neither form alone did: the
    // first shipped reading only the name, and the gateway's `find_file` keyed
    // `getToolSchema('', 'find_file')` — null, on every call, so a declaration
    // this guardrail exists to honour was never once read on the path every
    // catalog call takes.
    const [type, action] = toolName.includes('__')
      ? [toolName.slice(0, toolName.indexOf('__')), toolName.slice(toolName.indexOf('__') + 2)]
      : [ctx?.connector ?? '', toolName];
    // A custom API connection's operations are PER INSTANCE and are keyed by
    // connector id, not by type — `custom_api_connector` holds nothing in the
    // type map. Reading the type map for one returns null, which this guardrail
    // reads as "declares no host-only fields" rather than as "the lookup
    // missed": a declaration made on such an operation would never be honoured,
    // and nothing would say so. Resolved from the right map instead, so the
    // answer is the operation's own.
    const catalogType = catalogTypeFor(type);
    const schema = catalogType === CUSTOM_API_CONNECTOR_TYPE
      ? getCustomApiToolSchema(tenantId, type, action)
      : getToolSchema(catalogType, action);
    const egressOnly = schema?.egressOnly;
    if (!egressOnly || egressOnly.length === 0) return output;

    const sensitive = (schema.categories ?? []).map(String).includes('sensitive');
    const { modelVisible, sideChannel } = extractEgressOnly(output, egressOnly, {
      sensitive,
      // Only lift an ordinary declared field when there is a turn to hand it to.
      canDeliver: Boolean(ctx?.invocationId),
    });
    if (Object.keys(sideChannel).length > 0) {
      // Delivered, not just counted. This logged the paths and dropped the
      // values, so every field it lifted was removed from the model's copy and
      // then removed from existence — the surface built to show them had no
      // producer. PATHS still, never values: what was lifted is secret-shaped
      // by definition, and a log line is the one place it must not land.
      recordHostDelivered({ invocationId: ctx?.invocationId, toolName, fields: sideChannel });
      log.info({
        event: 'egress_only_extracted',
        metric: 'egress_only.extracted',
        toolName,
        paths: Object.keys(sideChannel),
        delivered: Boolean(ctx?.invocationId),
      }, 'lifted host-only fields off a result before the model saw it');
    }
    return modelVisible;
  },
};

/**
 * Record what a `writeRole: 'stage'` tool prepared (ADR-052 rule 5).
 *
 * Runs on the result of a successful stage call — the connector's own draft
 * operation, which a customer cannot observe — and mints the batch: a
 * host-minted id, a digest over the canonical arguments and the identifiers the
 * vendor returned, bound to tenant, agent, connector and the paired apply, and
 * expiring with the ask. The model is handed the opaque id on the result and
 * nothing else the protocol reads; the digest and the grant are never its to
 * hold. A stage the host cannot record is reported as such rather than let
 * through as a draft nothing will ever be able to commit.
 */
const stagedWriteGuardrail: ToolOutputGuardrail = {
  name: 'staged-write',
  async check(toolName, input, output, tenantId, ctx) {
    const [type, action] = toolName.includes('__')
      ? [toolName.slice(0, toolName.indexOf('__')), toolName.slice(toolName.indexOf('__') + 2)]
      : [ctx?.connector ?? '', toolName];
    const schema = getToolSchema(catalogTypeFor(type), action);
    if (schema?.writeRole !== 'stage' || !schema.paired_apply) return output;
    if (!ctx?.agentId || !ctx.connector) {
      throw new GuardrailBlockError('a staged write needs the agent and connector it was staged for; the draft was prepared but cannot be committed');
    }
    const { stagedBatchRepository } = await import('./staged-batches');
    const batch = await stagedBatchRepository().mint({
      tenantId,
      agentId: ctx.agentId,
      invocationId: ctx.invocationId,
      connector: ctx.connector,
      stageTool: action,
      applyTool: schema.paired_apply,
      input,
      output,
    });
    log.info({
      event: 'staged_write_recorded',
      tenant_id: tenantId,
      agent_id: ctx.agentId,
      invocation_id: ctx.invocationId,
      connector: ctx.connector,
      stage_tool: action,
      apply_tool: schema.paired_apply,
      batch_id: batch.id,
      item_count: batch.itemCount,
      vendor_ids: batch.vendorIds.length,
      // Earlier batches of the same change, cancelled by this one (clause 1).
      superseded: batch.superseded,
    }, 'staged write recorded; one approval of the paired apply commits it');
    // The opaque id, beside the vendor's answer. Only when the answer is an
    // object the id can ride on; a vendor answering with a bare value keeps it,
    // and the apply still finds the batch by the vendor's own identifier.
    return output && typeof output === 'object' && !Array.isArray(output)
      ? { ...(output as Record<string, unknown>), stagedBatchId: batch.id }
      : output;
  },
};

/** A document read returns the document, not its typography.
 *
 *  Google's `documents.get` answers with a styling tree whose size does not
 *  depend on the content: an EMPTY document is about 13 KB of list glyphs,
 *  indent magnitudes and named style definitions. That wrapping, carrying one
 *  newline, cannot be passed to a step with an 8,192-character budget that has
 *  declared it must read the document whole, so the run stops.
 *
 *  A guardrail rather than a fix in the step loop, because this is the one
 *  place every path to the model passes through: the same 13 KB would otherwise
 *  go into every chat turn and autonomous run that reads a document. */
const documentTextGuardrail: ToolOutputGuardrail = {
  name: 'document-text',
  async check(_toolName: string, _input: unknown, output: unknown): Promise<unknown> {
    return projectDocumentText(output);
  },
};

export const BUILTIN_OUTPUT_GUARDRAILS: ToolOutputGuardrail[] = [
  // Projection FIRST: every guardrail below it then walks the text rather than
  // 13 KB of style definitions, and the secret scrub has less to read.
  documentTextGuardrail,
  secretScrubGuardrail,
  egressOnlyGuardrail,
  stagedWriteGuardrail,
];

/** What the built-in guardrails made of one result: the data the model may
 *  read, or the reason it may read none of it. */
export type GuardedOutput =
  | { outcome: 'ok'; data: unknown }
  | { outcome: 'blocked'; reason: string; guardrail: string };

/**
 * Run every built-in guardrail over one tool result, in order.
 *
 * ONE runner for every path a result reaches the model by. The gateway's
 * `execute()` had this loop, and the in-process bridge that dispatches
 * Composio tools itself — the path most catalog tools take on the Claude
 * engine — did not: a credential in a Gmail body or a signed download URL in a
 * Drive result went to the model verbatim, while the tests for both guardrails
 * passed against the path that never carried them. A guardrail that is only
 * applied where somebody remembered to apply it is a guardrail with a list of
 * exceptions nobody wrote down.
 *
 * A guardrail that throws `GuardrailBlockError` empties the result rather than
 * failing the call — a blocked output is a result the model must not read,
 * not an error the tool returned. Any other throw propagates: a guardrail that
 * crashed has not scrubbed anything, and a result that skipped the scrubber
 * because it crashed is the failure this exists to prevent.
 */
export async function runOutputGuardrails(
  call: { actionType: string; payload: unknown; tenantId: string; invocationId?: string; connector?: string; agentId?: string },
  data: unknown,
): Promise<GuardedOutput> {
  let out = data;
  for (const guardrail of BUILTIN_OUTPUT_GUARDRAILS) {
    try {
      out = await guardrail.check(
        call.actionType,
        call.payload,
        out,
        call.tenantId,
        { invocationId: call.invocationId, connector: call.connector, agentId: call.agentId },
      );
    } catch (err) {
      if (err instanceof GuardrailBlockError) {
        log.warn({
          tenantId: call.tenantId,
          guardrail: guardrail.name,
          actionType: call.actionType,
        }, 'tool_output_blocked_by_guardrail');
        return { outcome: 'blocked', reason: err.message, guardrail: guardrail.name };
      }
      throw err;
    }
  }
  return { outcome: 'ok', data: out };
}
