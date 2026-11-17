// The stage/apply protocol, clause by clause (ADR-052 rule 5).
//
// One test per clause on the protocol's own functions and repository, over an
// in-memory scoped query that behaves like the table — so the clauses are held
// as properties of the protocol rather than of one vendor.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
  getPoolForService: jest.fn(),
  pool: { query: jest.fn() },
}));

import {
  StagedBatchRepository,
  batchDigest,
  itemCountOf,
  stagedApplyReasons,
  stringValuesOf,
  stripProtocolArgs,
  vendorIdsOf,
  verifyApply,
  STAGED_BATCH_TTL_MS,
  type ScopedQuery,
  type StagedBatch,
} from '../staged-batches';

/** A table in memory that answers the repository's statements. */
function fakeTable() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;
  const query: ScopedQuery = async (tenantId, text, params) => {
    const sql = text.replace(/\s+/g, ' ');
    if (sql.startsWith('INSERT INTO staged_write_batches')) {
      const row = {
        id: `batch-${++seq}`, tenant_id: params[0], agent_id: params[1], invocation_id: params[2], connector: params[3],
        stage_tool: params[4], apply_tool: params[5], vendor_ids: params[6], item_count: params[7], digest: params[8],
        status: 'staged', approval_id: null, approved_digest: null, applied_at: null, apply_result: null,
        created_at: new Date(), expires_at: params[9], stage_args_hash: params[10],
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT * FROM staged_write_batches WHERE id = $1')) {
      return { rows: rows.filter((r) => r.id === params[0] && r.tenant_id === tenantId) };
    }
    if (sql.startsWith('SELECT * FROM staged_write_batches WHERE tenant_id = $1')) {
      const [t, a, c, tool, values] = params as [string, string, string, string, string[]];
      const claimedOnly = sql.includes("status = 'applied' AND apply_result IS NULL");
      const hits = rows.filter((r) => r.tenant_id === t && r.agent_id === a && r.connector === c && r.apply_tool === tool
        && (r.vendor_ids as string[]).some((v) => values.includes(v))
        && (!claimedOnly || (r.status === 'applied' && r.apply_result === null)));
      hits.sort((x, y) => (y.created_at as Date).getTime() - (x.created_at as Date).getTime());
      return { rows: hits.slice(0, 1) };
    }
    if (sql.includes("SET status = 'approved', approval_id = $2")) {
      const r = rows.find((x) => x.id === params[0] && x.status === 'staged' && (x.expires_at as Date).getTime() > Date.now());
      if (!r) return { rows: [] };
      r.status = 'approved'; r.approval_id = params[1]; r.approved_digest = r.digest;
      if (params[2]) r.expires_at = new Date(Math.min((r.expires_at as Date).getTime(), (params[2] as Date).getTime()));
      return { rows: [r] };
    }
    if (sql.includes("SET status = 'cancelled'") && sql.includes('stage_args_hash = $5')) {
      // The re-stage supersession: every earlier batch of the same change,
      // under the same binding, still waiting for a decision.
      const [t, a, c, tool, hash, reason, keep] = params as [string, string, string, string, string, string, string];
      const hit = rows.filter((r) => r.tenant_id === t && r.agent_id === a && r.connector === c && r.stage_tool === tool
        && r.stage_args_hash === hash && r.status === 'staged' && r.id !== keep);
      for (const r of hit) { r.status = 'cancelled'; r.cancel_reason = reason; }
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    if (sql.includes("SET status = 'cancelled'")) {
      const key = sql.includes('WHERE approval_id = $1') ? 'approval_id' : sql.includes('WHERE invocation_id = $1') ? 'invocation_id' : 'id';
      const hit = rows.filter((r) => r[key] === params[0] && ['staged', 'approved'].includes(r.status as string));
      for (const r of hit) { r.status = 'cancelled'; r.cancel_reason = params[1]; }
      return { rows: [], rowCount: hit.length };
    }
    if (sql.includes("SET status = 'applied', applied_at = NOW()")) {
      const r = rows.find((x) => x.id === params[0] && x.digest === params[1] && x.approved_digest === params[1]
        && x.status === 'approved' && (x.expires_at as Date).getTime() > Date.now());
      if (!r) return { rows: [], rowCount: 0 };
      r.status = 'applied'; r.applied_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SET apply_result = $2::jsonb')) {
      const r = rows.find((x) => x.id === params[0]);
      if (r) r.apply_result = JSON.parse(params[1] as string);
      return { rows: [] };
    }
    if (sql.includes("SET status = 'approved', applied_at = NULL")) {
      const r = rows.find((x) => x.id === params[0] && x.status === 'applied' && x.apply_result === null);
      if (r) { r.status = 'approved'; r.applied_at = null; r.apply_result = JSON.parse(params[1] as string); }
      return { rows: [] };
    }
    throw new Error(`fake table: unhandled statement ${sql.slice(0, 80)}`);
  };
  return { rows, query };
}

const BINDING = { tenantId: 't1', agentId: 'a1', connector: 'mailchimp-1a2b', applyTool: 'send_campaign' };
const STAGE = {
  tenantId: 't1', agentId: 'a1', invocationId: 'inv-1', connector: 'mailchimp-1a2b',
  stageTool: 'create_campaign', applyTool: 'send_campaign',
  input: { type: 'regular', recipients: { list_id: 'L9' }, settings: { subject_line: 'September', from_name: 'Kestrel' } },
  output: { id: 'cmp_881', web_id: 4411, status: 'save' },
};

describe('clause 1 — a side-effect-free stage is recorded, not re-run', () => {
  it('mints one batch per stage from the dispatched call and the vendor answer; the stage itself is not touched', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    expect(t.rows).toHaveLength(1);
    expect(batch.status).toBe('staged');
    expect(batch.stageTool).toBe('create_campaign');
    expect(batch.applyTool).toBe('send_campaign');
    expect(batch.vendorIds).toEqual(['cmp_881']);
    expect(batch.superseded).toEqual([]);
  });

  it('repeating the stage changes nothing that can be applied: the latest batch supersedes the earlier one', async () => {
    // The same change staged twice is two drafts at the vendor and ONE
    // applicable batch here: the earlier one is cancelled by the re-stage, so
    // a person can only ever be asked about, and an apply can only ever
    // commit, the latest.
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const first = await repo.mint(STAGE);
    const again = await repo.mint({ ...STAGE, output: { id: 'cmp_882' } });
    expect(again.superseded).toEqual([first.id]);
    expect((await repo.get('t1', first.id))?.status).toBe('cancelled');
    expect(verifyApply((await repo.get('t1', first.id))!, BINDING).kind).toBe('refuse');
    expect((await repo.get('t1', again.id))?.status).toBe('staged');
    // Different arguments are a different change: both stay live.
    const other = await repo.mint({ ...STAGE, input: { ...STAGE.input, settings: { subject_line: 'October' } }, output: { id: 'cmp_883' } });
    expect(other.superseded).toEqual([]);
    expect((await repo.get('t1', again.id))?.status).toBe('staged');
  });

  it('a re-stage never supersedes a batch a person already approved', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const first = await repo.mint(STAGE);
    await repo.bindApproval('t1', first.id, 'appr-1');
    const again = await repo.mint({ ...STAGE, output: { id: 'cmp_882' } });
    expect(again.superseded).toEqual([]);
    expect((await repo.get('t1', first.id))?.status).toBe('approved');
    expect(verifyApply((await repo.get('t1', first.id))!, BINDING).kind).toBe('apply');
  });
});

describe('clause 2 — an opaque id and a host-computed digest', () => {
  it('the digest is over the canonical stage arguments and the vendor ids, the same every time and different for any change', () => {
    const a = batchDigest({ connector: 'c', stageTool: 's', input: { b: 2, a: 1 }, vendorIds: ['y', 'x'] });
    const b = batchDigest({ connector: 'c', stageTool: 's', input: { a: 1, b: 2 }, vendorIds: ['x', 'y'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(batchDigest({ connector: 'c', stageTool: 's', input: { a: 1, b: 3 }, vendorIds: ['x', 'y'] })).not.toBe(a);
    expect(batchDigest({ connector: 'c', stageTool: 's', input: { a: 1, b: 2 }, vendorIds: ['x'] })).not.toBe(a);
  });

  it('the id is the database\'s and the model\'s own arguments never enter the digest', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    expect(batch.id).toBe('batch-1');
    expect(batch.digest).toBe(batchDigest({ connector: STAGE.connector, stageTool: STAGE.stageTool, input: STAGE.input, vendorIds: ['cmp_881'] }));
    // The vendor ids are read off the answer, not the model's arguments.
    expect(vendorIdsOf({ id: 'cmp_881', list_id: 'L9', name: 'x', nested: { id: 'ignored' } })).toEqual(['cmp_881', 'L9']);
    expect(vendorIdsOf({ data: { campaignId: 'cmp_9' } })).toEqual(['cmp_9']);
    expect(itemCountOf({ rows: [1, 2, 3], other: [1] })).toBe(3);
    expect(itemCountOf({ subject: 'x' })).toBe(1);
  });
});

describe('clause 3 — bound to tenant, agent, connector and apply tool', () => {
  it('an apply under any other binding does not find the batch, and a found batch refuses a foreign binding', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    const args = { campaign_id: 'cmp_881' };
    expect(await repo.findForApply({ ...BINDING, applyArgs: args })).toMatchObject({ id: batch.id });
    expect(await repo.findForApply({ ...BINDING, agentId: 'a2', applyArgs: args })).toBeNull();
    expect(await repo.findForApply({ ...BINDING, connector: 'mailchimp-9z9z', applyArgs: args })).toBeNull();
    expect(await repo.findForApply({ ...BINDING, applyTool: 'delete_campaign', applyArgs: args })).toBeNull();
    expect(await repo.findForApply({ ...BINDING, applyArgs: { campaign_id: 'cmp_000' } })).toBeNull();
    const bound = await repo.bindApproval('t1', batch.id, 'appr-1');
    expect(verifyApply(bound!, { ...BINDING, tenantId: 't2' })).toMatchObject({ kind: 'refuse', reason: 'not_bound' });
    expect(verifyApply(bound!, { ...BINDING, applyTool: 'delete_campaign' })).toMatchObject({ kind: 'refuse', reason: 'not_bound' });
  });
});

describe('clause 4 — expiry with the ask, cancellation on rejection or withdrawal', () => {
  it('a batch expires 24 hours after staging, or with the ask when that is sooner', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    // Relative to the real clock: the bind runs against the table's own
    // `expires_at > NOW()`, so a batch staged at a fixed date is already
    // expired once that date is a day old.
    const stagedAt = new Date();
    const askExpiresAt = new Date(stagedAt.getTime() + 2 * 60 * 60 * 1000);
    const staged = await repo.mint({ ...STAGE, now: stagedAt });
    expect(staged.expiresAt.getTime() - stagedAt.getTime()).toBe(STAGED_BATCH_TTL_MS);
    const bound = await repo.bindApproval('t1', staged.id, 'appr-1', askExpiresAt);
    expect(bound!.expiresAt.toISOString()).toBe(askExpiresAt.toISOString());
    expect(verifyApply(bound!, BINDING, new Date(askExpiresAt.getTime() + 1000))).toMatchObject({ kind: 'refuse', reason: 'expired' });
    expect(verifyApply(bound!, BINDING, new Date(askExpiresAt.getTime() - 1000))).toMatchObject({ kind: 'apply' });
  });

  it('a rejected ask cancels its batch, a withdrawn run cancels every batch it staged, and neither can be applied or un-cancelled', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const a = await repo.mint(STAGE);
    // A second, DIFFERENT change in the same run: two live batches, not a
    // re-stage of one (which would supersede `a` before anything decided it).
    const b = await repo.mint({ ...STAGE, input: { ...STAGE.input, settings: { subject_line: 'October' } }, output: { id: 'cmp_882' } });
    expect(await repo.cancelById('t1', a.id, 'rejected')).toBe(true);
    expect(await repo.cancelForInvocation('t1', 'inv-1', 'withdrawn')).toBe(1);
    for (const id of [a.id, b.id]) {
      const now = (await repo.get('t1', id))!;
      expect(now.status).toBe('cancelled');
      expect(verifyApply(now, BINDING)).toMatchObject({ kind: 'refuse', reason: 'cancelled' });
      // The model cannot un-cancel one: an approval does not take a cancelled batch.
      expect(await repo.bindApproval('t1', id, 'appr-9')).toBeNull();
    }
  });
});

describe('clause 5 — approval of the final staged digest', () => {
  it('a person\'s yes binds to the digest as staged; a re-stage is a new batch the old approval does not cover', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const first = await repo.mint(STAGE);
    const bound = (await repo.bindApproval('t1', first.id, 'appr-1'))!;
    expect(bound.approvedDigest).toBe(first.digest);
    expect(verifyApply(bound, BINDING)).toMatchObject({ kind: 'apply' });
    // Edited, so re-staged: a different digest under a different id.
    const restaged = await repo.mint({ ...STAGE, input: { ...STAGE.input, settings: { subject_line: 'October' } }, output: { id: 'cmp_883' } });
    expect(restaged.id).not.toBe(first.id);
    expect(restaged.digest).not.toBe(first.digest);
    expect(verifyApply(restaged, BINDING)).toMatchObject({ kind: 'refuse', reason: 'not_approved' });
    // An unapproved batch is never applied.
    const staged = await repo.mint({ ...STAGE, output: { id: 'cmp_884' } });
    expect(verifyApply(staged, BINDING)).toMatchObject({ kind: 'refuse', reason: 'not_approved' });
  });
});

describe('clause 6 — host-controlled grant storage', () => {
  it('the grant is written by the host on the batch, and a batch whose approved digest disagrees with its digest is refused', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    const bound = (await repo.bindApproval('t1', batch.id, 'appr-1'))!;
    expect(bound.approvalId).toBe('appr-1');
    expect(bound.approvedDigest).toBe(bound.digest);
    // Tampered storage — the two host-written columns disagree — is a refusal.
    const tampered: StagedBatch = { ...bound, approvedDigest: 'someone-elses-digest' };
    expect(verifyApply(tampered, BINDING)).toMatchObject({ kind: 'refuse', reason: 'digest_mismatch' });
  });
});

describe('clause 7 — atomic apply, or documented partial failure', () => {
  it('the family that opts in first applies with ONE vendor call, and a failed call hands the claim back rather than recording a partial success', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    await repo.bindApproval('t1', batch.id, 'appr-1');
    expect(await repo.claimApply('t1', batch.id, batch.digest)).toBe(true);
    // The vendor call failed: the claim goes back, with the error on record.
    await repo.releaseApply('t1', batch.id, 'vendor 502');
    const after = (await repo.get('t1', batch.id))!;
    expect(after.status).toBe('approved');
    expect(after.applyResult).toEqual({ error: 'vendor 502' });
    expect(verifyApply(after, BINDING)).toMatchObject({ kind: 'apply' });
  });
});

describe('clause 8 — idempotent apply and retry', () => {
  it('the apply is claimed on (id, digest) once; a retry of a completed apply replays the recorded result and writes nothing', async () => {
    const t = fakeTable();
    const repo = new StagedBatchRepository(t.query);
    const batch = await repo.mint(STAGE);
    await repo.bindApproval('t1', batch.id, 'appr-1');
    expect(await repo.claimApply('t1', batch.id, batch.digest)).toBe(true);
    // A second claim on the same (id, digest) finds nothing to claim.
    expect(await repo.claimApply('t1', batch.id, batch.digest)).toBe(false);
    // Claimed and unsettled: not applied again, not replayed either.
    const inFlight = (await repo.get('t1', batch.id))!;
    expect(verifyApply(inFlight, BINDING)).toMatchObject({ kind: 'refuse', reason: 'in_flight' });
    await repo.recordApplyResult('t1', batch.id, { sent: true, campaign: 'cmp_881' });
    const done = (await repo.get('t1', batch.id))!;
    expect(verifyApply(done, BINDING)).toEqual({ kind: 'replay', batch: done, result: { sent: true, campaign: 'cmp_881' } });
    // A claim under a different digest never lands.
    expect(await repo.claimApply('t1', batch.id, 'other')).toBe(false);
  });
});

describe('clause 9 — no model-supplied substitution', () => {
  it('the apply carries the vendor\'s id and nothing the protocol reads; a digest, batch id or grant the model passes is stripped', () => {
    const { args, stripped } = stripProtocolArgs({ campaign_id: 'cmp_881', stagedBatchId: 'batch-7', digest: 'ffff', grant: { ok: true } });
    expect(args).toEqual({ campaign_id: 'cmp_881' });
    expect(stripped).toEqual(['stagedBatchId', 'digest', 'grant']);
    // The batch is found by the vendor id in the arguments, at any depth.
    expect(stringValuesOf({ campaign_id: 'cmp_881', options: { note: 'x' }, list: ['y'] })).toEqual(['cmp_881', 'x', 'y']);
  });
});

describe('the ask', () => {
  it('an apply-role tool always asks, under the size reason, naming the batch it commits', () => {
    const tools = [
      { name: 'mailchimp-1a2b__send_campaign', writeRole: 'apply' },
      { name: 'mailchimp-1a2b__create_campaign', writeRole: 'stage' },
      { name: 'mailchimp-1a2b__list_campaigns' },
    ];
    const resolve = (name: string) => tools.find((t) => t.name === name);
    expect(stagedApplyReasons([{ name: 'mailchimp-1a2b__send_campaign', input: { campaign_id: 'cmp_881' } }], resolve))
      .toEqual(['mailchimp-1a2b__send_campaign commits a staged batch (cmp_881)']);
    expect(stagedApplyReasons([{ name: 'mailchimp-1a2b__create_campaign', input: {} }], resolve)).toEqual([]);
    expect(stagedApplyReasons([{ name: 'mailchimp-1a2b__list_campaigns', input: {} }], resolve)).toEqual([]);
  });
});
