// The stage/apply protocol for a batch approval (ADR-052 rule 5).
//
// A connector may declare that one tool PREPARES a change (`writeRole: 'stage'`)
// and a paired tool COMMITS it (`writeRole: 'apply'`, named by `paired_apply`).
// The declaration and its boot-time validator existed; nothing at runtime
// staged, bound, digested, expired, approved or applied anything, so "apply"
// would have been N ordinary writes under one bypass. This is the runtime
// half, clause by clause:
//
//   1. A side-effect-free stage. The stage tool is the connector's own draft
//      operation — a draft campaign, an unpublished item — which writes nothing
//      a customer or a third party can observe. The host records what it
//      prepared; it does not re-run it. Repeating the stage prepares another
//      draft at the vendor, and it changes nothing that can be APPLIED: a new
//      batch with the same arguments under the same binding supersedes every
//      earlier one still waiting for a decision, so at most the latest can be
//      asked about, approved or committed (`stage_args_hash`, migration 411).
//      A batch a person already approved is never superseded.
//   2. An opaque id and a digest. The batch id is minted by the database
//      (gen_random_uuid) and the digest is sha256 over the canonical stage
//      arguments plus the identifiers the vendor returned — computed here from
//      the call the gateway dispatched, never from anything the model said.
//   3. Binding. Tenant, agent, the connector instance and the apply tool. An
//      apply under any other binding does not find the batch.
//   4. Expiry and cancellation. The batch expires with the ask (24 hours); a
//      rejected ask or a withdrawn run cancels it. Neither state applies.
//   5. Approval of the final digest. A person approves the apply call that
//      names the batch; the digest as staged is written against the approval.
//      A re-stage is a new batch with a new id and digest, so an approval binds
//      to exactly one staged item set.
//   6. Host-controlled grant storage. `approval_id` and `approved_digest` on the
//      batch; the grant columns on the approval row. Both host-written.
//   7. Atomic apply, or documented partial failure. The apply is ONE vendor
//      call on the family that opts in first (a campaign send), which the
//      vendor commits whole or not at all; a family whose apply is not atomic
//      documents per-item outcomes before it declares the pair.
//   8. Idempotent apply. The apply is claimed on (batch id, digest): the batch
//      moves to `applied` with the result recorded, and a retry answers with
//      the recorded result and performs no second write.
//   9. No model-supplied substitution. The apply's arguments carry the vendor's
//      id and nothing else the protocol reads; a digest, item set or grant the
//      model passes is stripped and logged, never consulted.
//
// The protocol functions are pure over a batch row; the repository is the
// thin Postgres surface under them, tenant-scoped like every table here.

import { createHash } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { canonicalJson } from '../agent-execution/sideeffect-idempotency';
import { logger } from '../infrastructure/logging';

export type StagedBatchStatus = 'staged' | 'approved' | 'applied' | 'cancelled' | 'expired';

export interface StagedBatch {
  id: string;
  tenantId: string;
  agentId: string;
  invocationId: string | null;
  connector: string;
  stageTool: string;
  applyTool: string;
  vendorIds: string[];
  itemCount: number;
  digest: string;
  /** sha256 over the canonical stage arguments: what makes a re-stage with
   *  the same arguments recognisable as the same intended change. */
  stageArgsHash: string | null;
  status: StagedBatchStatus;
  approvalId: string | null;
  approvedDigest: string | null;
  appliedAt: Date | null;
  applyResult: unknown;
  createdAt: Date;
  expiresAt: Date;
}

/** The ask's own expiry: a batch outlives its ask by nothing. */
export const STAGED_BATCH_TTL_MS = 24 * 60 * 60 * 1000;

/** Argument names the protocol owns. A model may not supply them on an apply;
 *  they are stripped before the vendor sees the call, and their presence is
 *  logged (clause 9). */
export const PROTOCOL_ARG_NAMES: readonly string[] = ['stagedBatchId', 'staged_batch_id', 'batchDigest', 'batch_digest', 'digest', 'grant'];

/** The identifiers the vendor returned for what it prepared: top-level `id`,
 *  `*_id` and `*Id` string fields of the output (and of `data` when the
 *  vendor wraps), which is where every family's draft id lives. */
export function vendorIdsOf(output: unknown): string[] {
  const ids = new Set<string>();
  const scan = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length === 0) continue;
      if (k === 'id' || /_id$/.test(k) || /Id$/.test(k)) ids.add(v);
    }
  };
  scan(output);
  scan((output as { data?: unknown } | null)?.data);
  return [...ids];
}

/** How many items the stage prepared: the largest array the arguments carry,
 *  else one. A campaign is one item; a bulk price change is its rows. */
export function itemCountOf(input: unknown): number {
  let max = 0;
  const scan = (o: unknown) => {
    if (Array.isArray(o)) { max = Math.max(max, o.length); return; }
    if (!o || typeof o !== 'object') return;
    for (const v of Object.values(o as Record<string, unknown>)) scan(v);
  };
  scan(input);
  return Math.max(1, max);
}

/** The digest over the exact staged item set. Host-computed from the
 *  dispatched call and the vendor's answer; the same input always digests
 *  the same, and any change to what was staged changes it. */
export function batchDigest(args: {
  connector: string;
  stageTool: string;
  input: unknown;
  vendorIds: readonly string[];
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      connector: args.connector,
      stageTool: args.stageTool,
      input: args.input ?? {},
      vendorIds: [...args.vendorIds].sort(),
    }))
    .digest('hex');
}

/** The hash a re-stage is recognised by: the canonical arguments alone, so
 *  the same intended change staged twice — two drafts, two vendor ids — reads
 *  as one. */
export function stageArgsHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input ?? {})).digest('hex');
}

/** The string values an apply's arguments carry, at any depth: an apply names
 *  its batch by the vendor's id, wherever the vendor's schema puts it. */
export function stringValuesOf(args: unknown): string[] {
  const out: string[] = [];
  const scan = (o: unknown) => {
    if (typeof o === 'string') { if (o.length > 0) out.push(o); return; }
    if (Array.isArray(o)) { for (const v of o) scan(v); return; }
    if (o && typeof o === 'object') for (const v of Object.values(o as Record<string, unknown>)) scan(v);
  };
  scan(args);
  return out;
}

/** Strip the protocol's own argument names off an apply call (clause 9).
 *  Returns the cleaned arguments and which names were removed. */
export function stripProtocolArgs(args: Record<string, unknown> | undefined): {
  args: Record<string, unknown>;
  stripped: string[];
} {
  const stripped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (PROTOCOL_ARG_NAMES.includes(k)) stripped.push(k);
    else out[k] = v;
  }
  return { args: out, stripped };
}

export type ApplyVerdict =
  | { kind: 'apply'; batch: StagedBatch }
  | { kind: 'replay'; batch: StagedBatch; result: unknown }
  | { kind: 'refuse'; reason: 'not_bound' | 'expired' | 'cancelled' | 'not_approved' | 'digest_mismatch' | 'in_flight'; detail: string };

/**
 * Whether an apply may commit this batch, now. Pure over the row.
 *
 * Refuses on any binding other than the one it was staged under, on an expired
 * or cancelled batch, on a batch no person approved, and on a batch whose
 * digest is not the one the person approved. Answers `replay` for a batch
 * already applied — the recorded result, no second write.
 */
export function verifyApply(
  batch: StagedBatch,
  binding: { tenantId: string; agentId: string; connector: string; applyTool: string },
  now: Date = new Date(),
): ApplyVerdict {
  if (
    batch.tenantId !== binding.tenantId
    || batch.agentId !== binding.agentId
    || batch.connector !== binding.connector
    || batch.applyTool !== binding.applyTool
  ) {
    return { kind: 'refuse', reason: 'not_bound', detail: `staged batch ${batch.id} is bound to ${batch.connector}.${batch.applyTool} for another tenant, agent or connector` };
  }
  if (batch.status === 'applied') {
    // Claimed and not yet settled: the vendor call is in flight, or its settle
    // was lost. Neither is a reason to send again; the recorded result, once
    // there is one, is the replay.
    if (batch.applyResult === null || batch.applyResult === undefined) {
      return { kind: 'refuse', reason: 'in_flight', detail: `staged batch ${batch.id} is being applied; not applied again` };
    }
    return { kind: 'replay', batch, result: batch.applyResult };
  }
  if (batch.status === 'cancelled') {
    return { kind: 'refuse', reason: 'cancelled', detail: `staged batch ${batch.id} was cancelled` };
  }
  if (batch.status === 'expired' || batch.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'refuse', reason: 'expired', detail: `staged batch ${batch.id} expired with its ask` };
  }
  if (batch.status !== 'approved' || !batch.approvalId || !batch.approvedDigest) {
    return { kind: 'refuse', reason: 'not_approved', detail: `staged batch ${batch.id} has not been approved by a person` };
  }
  if (batch.approvedDigest !== batch.digest) {
    return { kind: 'refuse', reason: 'digest_mismatch', detail: `staged batch ${batch.id} is not the batch that was approved` };
  }
  return { kind: 'apply', batch };
}

// ── Repository ─────────────────────────────────────────────────────────

export type ScopedQuery = (
  tenantId: string,
  text: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;

const defaultScopedQuery: ScopedQuery = (tenantId, text, params) =>
  withTenantScope(tenantId, (client) => client.query(text, params), 'tool-gateway');

function rowToBatch(r: Record<string, unknown>): StagedBatch {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    agentId: r.agent_id as string,
    invocationId: (r.invocation_id as string | null) ?? null,
    connector: r.connector as string,
    stageTool: r.stage_tool as string,
    applyTool: r.apply_tool as string,
    vendorIds: (r.vendor_ids as string[] | null) ?? [],
    itemCount: Number(r.item_count ?? 1),
    digest: r.digest as string,
    stageArgsHash: (r.stage_args_hash as string | null) ?? null,
    status: r.status as StagedBatchStatus,
    approvalId: (r.approval_id as string | null) ?? null,
    approvedDigest: (r.approved_digest as string | null) ?? null,
    appliedAt: (r.applied_at as Date | null) ?? null,
    applyResult: r.apply_result ?? null,
    createdAt: r.created_at as Date,
    expiresAt: r.expires_at as Date,
  };
}

export class StagedBatchRepository {
  constructor(private readonly query: ScopedQuery = defaultScopedQuery) {}

  /** Record what a stage prepared. The id and the digest are the host's.
   *
   *  A re-stage with the same arguments under the same binding supersedes
   *  every earlier batch still `staged`: those are cancelled, and only the
   *  batch minted here can be asked about or applied. Returns the batch with
   *  the ids it superseded, for the record. */
  async mint(args: {
    tenantId: string;
    agentId: string;
    invocationId?: string;
    connector: string;
    stageTool: string;
    applyTool: string;
    input: unknown;
    output: unknown;
    now?: Date;
  }): Promise<StagedBatch & { superseded: string[] }> {
    const vendorIds = vendorIdsOf(args.output);
    const digest = batchDigest({ connector: args.connector, stageTool: args.stageTool, input: args.input, vendorIds });
    const argsHash = stageArgsHash(args.input);
    const now = args.now ?? new Date();
    const { rows } = await this.query(
      args.tenantId,
      `INSERT INTO staged_write_batches
         (tenant_id, agent_id, invocation_id, connector, stage_tool, apply_tool, vendor_ids, item_count, digest, expires_at, stage_args_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        args.tenantId, args.agentId, args.invocationId ?? null, args.connector, args.stageTool, args.applyTool,
        vendorIds, itemCountOf(args.input), digest, new Date(now.getTime() + STAGED_BATCH_TTL_MS), argsHash,
      ],
    );
    const minted = rowToBatch(rows[0]);
    // Only what is still waiting for a decision. An approved batch is the one
    // a person said yes to, and stays applicable whatever is staged after it.
    const superseded = await this.query(
      args.tenantId,
      `UPDATE staged_write_batches
          SET status = 'cancelled', cancel_reason = $6, updated_at = NOW()
        WHERE tenant_id = $1 AND agent_id = $2 AND connector = $3 AND stage_tool = $4
          AND stage_args_hash = $5 AND status = 'staged' AND id <> $7
        RETURNING id`,
      [
        args.tenantId, args.agentId, args.connector, args.stageTool, argsHash,
        `superseded by staged batch ${minted.id}: the same change was staged again`, minted.id,
      ],
    );
    return { ...minted, superseded: superseded.rows.map((r) => r.id as string) };
  }

  /** The live batch an apply's arguments name, within its binding: the newest
   *  batch under this tenant, agent, connector and apply tool whose vendor ids
   *  include a value the arguments carry. */
  async findForApply(args: {
    tenantId: string;
    agentId: string;
    connector: string;
    applyTool: string;
    applyArgs: unknown;
  }): Promise<StagedBatch | null> {
    const values = stringValuesOf(args.applyArgs);
    if (values.length === 0) return null;
    const { rows } = await this.query(
      args.tenantId,
      `SELECT * FROM staged_write_batches
        WHERE tenant_id = $1 AND agent_id = $2 AND connector = $3 AND apply_tool = $4
          AND vendor_ids && $5::text[]
        ORDER BY created_at DESC
        LIMIT 1`,
      [args.tenantId, args.agentId, args.connector, args.applyTool, values],
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  async get(tenantId: string, id: string): Promise<StagedBatch | null> {
    const { rows } = await this.query(tenantId, `SELECT * FROM staged_write_batches WHERE id = $1`, [id]);
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  /** A person approved the apply naming this batch: the grant, host-written,
   *  against the digest as staged. Only a live staged batch takes it. */
  async bindApproval(tenantId: string, id: string, approvalId: string, approvalExpiresAt?: Date): Promise<StagedBatch | null> {
    const { rows } = await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'approved', approval_id = $2, approved_digest = digest,
              expires_at = LEAST(expires_at, COALESCE($3, expires_at)), updated_at = NOW()
        WHERE id = $1 AND status = 'staged' AND expires_at > NOW()
        RETURNING *`,
      [id, approvalId, approvalExpiresAt ?? null],
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  /** Cancel one live batch (a rejected ask names the batch its apply named). */
  async cancelById(tenantId: string, id: string, reason: string): Promise<boolean> {
    const r = await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status IN ('staged', 'approved')`,
      [id, reason],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Cancel every live batch an approval covers (a rejected ask). */
  async cancelForApproval(tenantId: string, approvalId: string, reason: string): Promise<number> {
    const r = await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
        WHERE approval_id = $1 AND status IN ('staged', 'approved')`,
      [approvalId, reason],
    );
    return r.rowCount ?? 0;
  }

  /** Cancel every live batch a run staged (a withdrawn run). */
  async cancelForInvocation(tenantId: string, invocationId: string, reason: string): Promise<number> {
    const r = await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
        WHERE invocation_id = $1 AND status IN ('staged', 'approved')`,
      [invocationId, reason],
    );
    return r.rowCount ?? 0;
  }

  /** The apply's one act, claimed on (id, digest). False when the batch was
   *  not the approved, live one it was a moment ago — another apply got there,
   *  or the batch moved — in which case nothing is written. */
  async claimApply(tenantId: string, id: string, digest: string): Promise<boolean> {
    const r = await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'applied', applied_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND digest = $2 AND approved_digest = $2 AND status = 'approved' AND expires_at > NOW()`,
      [id, digest],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** The batch an apply CLAIMED and has not yet settled, by the apply's
   *  arguments within its binding: applied, with no result recorded yet. The
   *  settle finds its batch this way rather than through anything held in
   *  memory, because the claim and the settle may run on different instances. */
  async findClaimedForSettle(args: {
    tenantId: string;
    agentId: string;
    connector: string;
    applyTool: string;
    applyArgs: unknown;
  }): Promise<StagedBatch | null> {
    const values = stringValuesOf(args.applyArgs);
    if (values.length === 0) return null;
    const { rows } = await this.query(
      args.tenantId,
      `SELECT * FROM staged_write_batches
        WHERE tenant_id = $1 AND agent_id = $2 AND connector = $3 AND apply_tool = $4
          AND vendor_ids && $5::text[] AND status = 'applied' AND apply_result IS NULL
        ORDER BY applied_at DESC
        LIMIT 1`,
      [args.tenantId, args.agentId, args.connector, args.applyTool, values],
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  async recordApplyResult(tenantId: string, id: string, result: unknown): Promise<void> {
    await this.query(
      tenantId,
      `UPDATE staged_write_batches SET apply_result = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(result ?? null)],
    );
  }

  /** A claimed apply whose vendor call failed hands the claim back, so the
   *  person's approval is not spent on a write that did not happen. */
  async releaseApply(tenantId: string, id: string, error: string): Promise<void> {
    await this.query(
      tenantId,
      `UPDATE staged_write_batches
          SET status = 'approved', applied_at = NULL, apply_result = $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'applied' AND apply_result IS NULL`,
      [id, JSON.stringify({ error })],
    );
  }
}

let repository: StagedBatchRepository | null = null;
export function stagedBatchRepository(): StagedBatchRepository {
  if (!repository) repository = new StagedBatchRepository();
  return repository;
}
/** Test seam. */
export function _setStagedBatchRepository(r: StagedBatchRepository | null): void {
  repository = r;
}

/** The staged-apply ask: an apply-role tool in a batch always asks a person,
 *  whatever the size thresholds say, because the one ask is the batch's whole
 *  point. Pure over the tools as the gate sees them. */
export function stagedApplyReasons(
  calls: ReadonlyArray<{ name: string; input?: unknown }>,
  resolve: (name: string) => { name: string; writeRole?: string } | undefined,
): string[] {
  const reasons: string[] = [];
  for (const call of calls) {
    const tool = resolve(call.name);
    if (tool?.writeRole !== 'apply') continue;
    const ids = stringValuesOf(call.input).slice(0, 3).join(', ');
    reasons.push(`${tool.name} commits a staged batch${ids ? ` (${ids})` : ''}`);
  }
  return reasons;
}

export function logStrippedProtocolArgs(args: { tenantId: string; toolName: string; stripped: string[] }): void {
  if (args.stripped.length === 0) return;
  logger.warn(
    { tenant_id: args.tenantId, tool_name: args.toolName, stripped: args.stripped, event: 'staged_apply_model_supplied_args_ignored' },
    'staged apply: the model supplied protocol arguments; ignored — the batch, its digest and its grant are resolved host-side',
  );
}
