// checkHitlGate under declared scope: what a human approved runs, what they did
// not still asks, and the hard invariants ignore both.
//
// Take a tenant with `escalation: important` and all six sensitive-work
// categories on. That is a reasonable conservative choice and the platform
// executes it faithfully — but a code-host comment classifies as `dataChanges`,
// so a reviewer agent has to ask permission to write each of its own review
// comments. Fixing the external-content invariant alone only moves the gate:
// the same call then raises `sensitive_work` with a different reason string and
// an identical-looking card.

import type { ModelTool, OversightSettings, ToolCallRequest } from '../types';

jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [{ count: '0' }] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (_t: string, fn: (c: { query: typeof sharedQuery }) => Promise<unknown>) => fn({ query: sharedQuery })),
  };
});
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
  createGovernanceApprovalPolicy: jest.fn().mockResolvedValue(undefined),
  getAgentActionTrust: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../clients/platform-backend-client', () => ({ fetchOversightSettings: jest.fn() }));

import { HitlEnforcementService } from '../service';
import { getGovernanceApprovalPolicy } from '../../governance/governance-service-client';

const mockPolicy = getGovernanceApprovalPolicy as jest.Mock;

/** A conservative configuration, faithfully executed. */
const oversight = {
  tenantId: 't1', autonomy: 'balanced', escalation: 'important', communication: 'auto',
  sensitiveWork: {
    customerCommunication: true, financialActions: true, dataChanges: true,
    externalPublishing: true, hiringDecisions: true, mergeToMain: true,
  },
} as unknown as OversightSettings;

/** Same, with the merge toggle switched OFF. */
const mergeToggleOff = {
  ...oversight,
  sensitiveWork: { ...(oversight.sensitiveWork as object), mergeToMain: false },
} as unknown as OversightSettings;

const COMMENT = 'github-dd4c4689__add_comment_to_pending_review';
const MERGE = 'github-dd4c4689__merge_pull_request';
const GITLAB_MERGE = 'gitlab-1924102e__accept_merge_request';

const commentTool: ModelTool = {
  name: COMMENT, description: 'Comment on a pending review',
  categories: ['dataChanges'], effect: 'write',
};
const mergeTool: ModelTool = {
  name: MERGE, description: 'Merge a pull request',
  categories: ['dataChanges'], effect: 'write',
};
const gitlabMergeTool: ModelTool = {
  name: GITLAB_MERGE, description: 'Accept a merge request',
  categories: ['dataChanges'], effect: 'write',
};

const triggerTarget = { source: 'github', repository: 'acme/webapp', number: 42 };

function call(name: string, input: Record<string, unknown>): ToolCallRequest {
  return { id: '1', name, input } as unknown as ToolCallRequest;
}
const onThePr = { owner: 'acme', repo: 'webapp', pullNumber: 42 };

describe('declared scope clears sensitive_work', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  it('gates the comment when nothing declared it — unchanged behaviour', async () => {
    // The adapter path. The model chose the tool; no step declared it.
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr)], oversight, 3, [commentTool], 't1', 'a1', { triggerTarget },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('sensitive_work');
  });

  it('clears the comment when the approved graph declared it', async () => {
    // THE change. s8 exists in the approved graph, dispatches the tool it
    // declares, against the pull request that woke the run.
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr)], oversight, 3, [commentTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: COMMENT } },
    );
    expect(res.shouldGate).toBe(false);
  });

  it('still gates when the declared step reaches a DIFFERENT entity', async () => {
    const res = await svc.checkHitlGate(
      [call(COMMENT, { ...onThePr, repo: 'some-other-repo' })],
      oversight, 3, [commentTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: COMMENT } },
    );
    expect(res.shouldGate).toBe(true);
  });

  it('still gates when the step declares a different tool than the one dispatched', async () => {
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr)], oversight, 3, [commentTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: 'github-dd4c4689__get_pull_request' } },
    );
    expect(res.shouldGate).toBe(true);
  });

  it('gates the whole batch when only some calls are in scope', async () => {
    // Approving a batch approves the one call in it that reached beyond the
    // trigger — the same rule `allInPlace` follows.
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr), call(COMMENT, { ...onThePr, pullNumber: 99 })],
      oversight, 3, [commentTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: COMMENT } },
    );
    expect(res.shouldGate).toBe(true);
  });
});

describe('the hard invariant ignores the graph AND the toggle', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  it('a DECLARED merge on the triggering PR still gates', async () => {
    // The case that killed the first draft of the in-place carve-out.
    // `merge_pull_request` classifies as ['dataChanges'] — not destructive — so
    // a rule about non-destructive writes to the triggering entity would have
    // let an agent merge the pull request that woke it.
    const res = await svc.checkHitlGate(
      [call(MERGE, onThePr)], oversight, 3, [mergeTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's9', toolName: MERGE } },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('merge_to_main');
  });

  it('gates a merge even with the mergeToMain toggle switched OFF', async () => {
    // The position that disappears: "nothing stands between an agent and
    // main". This control has already been off by accident once, silently, in
    // the direction that costs most.
    const res = await svc.checkHitlGate(
      [call(MERGE, onThePr)], mergeToggleOff, 3, [mergeTool], 't1', 'a1', { triggerTarget },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('merge_to_main');
  });

  it('covers GitLab, which had no entry in the name set', async () => {
    const res = await svc.checkHitlGate(
      [call(GITLAB_MERGE, { project_id: 42, merge_request_iid: 7 })],
      mergeToggleOff, 3, [gitlabMergeTool], 't1', 'a1', {},
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('merge_to_main');
  });

  it('a standing per-agent policy still clears a merge', async () => {
    // Absolute does not mean unbypassable. It means the bypass is a deliberate
    // per-agent act rather than a workspace checkbox.
    mockPolicy.mockResolvedValue({ decision: 'approved' });
    const res = await svc.checkHitlGate(
      [call(MERGE, onThePr)], oversight, 3, [mergeTool], 't1', 'a1', { triggerTarget },
    );
    expect(res.shouldGate).toBe(false);
  });

  it('super-destructive is still not clearable by a declaration', async () => {
    const tool: ModelTool = { name: 'delete_tenant', description: 'Delete', categories: [], effect: 'write' };
    const res = await svc.checkHitlGate(
      [call('delete_tenant', { id: 't1' })], oversight, 3, [tool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's1', toolName: 'delete_tenant' } },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('super_destructive_gate');
  });
});

describe('declared scope does not reach the reasons it must not', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  it('level 1 means EVERY action gates, declaration or not', async () => {
    // The operator asked for every action to be gated. Exempting declared work
    // would override an explicit instruction with an inference.
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr)], oversight, 1, [commentTool], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: COMMENT } },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('level_1_gate');
  });

  it('a DESTRUCTIVE-marked tool still gates at level 2', async () => {
    // Being declared does not make a destructive act reversible.
    const destructive: ModelTool = {
      name: COMMENT, description: '⚠️ DESTRUCTIVE removes things', categories: ['dataChanges'], effect: 'write',
    };
    const res = await svc.checkHitlGate(
      [call(COMMENT, onThePr)], oversight, 2, [destructive], 't1', 'a1',
      { triggerTarget, declaredStep: { stepId: 's8', toolName: COMMENT } },
    );
    expect(res.shouldGate).toBe(true);
    expect(res.reason).toBe('destructive_gate');
  });
});

// ── a declared Slack lookup, end to end ──────────────────────────────────
//
// Without these fixes a person is asked to authorise looking up the id of the
// Slack channel the agent's own approved workflow names. Three defects meet:
//   1. the tool carried no read/write signal, so a LOOKUP gated as a write
//   2. declared scope required targeting the trigger, so a notification step
//      read as a deviation from the workflow that declares it
//   3. the exemption was wired to `sensitive_work`, a reason a reactive run
//      never reaches — so it could not have helped even if (2) were fixed
describe('a declared Slack lookup on an untrusted-inbound run', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  const LOOKUP = 'agent_slack__slack_resolve_channel_by_name';
  const readTool: ModelTool = {
    name: LOOKUP, description: 'Find a channel by its human name',
    // What the catalog now states. Before, this carried NEITHER signal.
    effect: 'read', categories: [],
  } as unknown as ModelTool;
  const s11 = {
    stepId: 's11', toolName: LOOKUP,
    description: 'Resolve the #code-reviewer Slack channel so the notification can be posted.',
    argumentsAuthored: true,
  };
  const untrusted = { trustLevel: 'untrusted_inbound' as const, triggerTarget };

  it('does not gate — a lookup is a read', () => {
    // Fix 1 alone is enough here, and is the narrowest of the three.
    const res = svc.checkHitlGate(
      [call(LOOKUP, { name: 'code-reviewer' })], oversight, 3, [readTool], 't1', 'a1',
      { ...untrusted, declaredStep: s11 },
    );
    return res.then((r) => expect(r.shouldGate).toBe(false));
  });

  it('does not gate even if the tool were still unclassified', () => {
    // Fixes 2+3 are the belt to fix 1's braces: a declared step with authored
    // arguments clears external_content_write regardless of classification,
    // because the graph fixed both the tool and the arguments before any
    // untrusted content existed.
    const unclassified: ModelTool = {
      name: LOOKUP, description: 'Find a channel by its human name',
    } as unknown as ModelTool;
    const res = svc.checkHitlGate(
      [call(LOOKUP, { name: 'code-reviewer' })], oversight, 3, [unclassified], 't1', 'a1',
      { ...untrusted, declaredStep: s11 },
    );
    return res.then((r) => expect(r.shouldGate).toBe(false));
  });

  it('STILL gates when a step interpolates run-derived text', () => {
    // The exemption must not reach a step whose arguments were written after
    // reading the untrusted diff.
    //
    // NOT tested with slack_send_message: `internalCollaboration` is already
    // exempt from this invariant by a deliberate earlier fix — "a post into the
    // workspace's OWN Slack or Teams is not an external write" — so it would
    // pass for a reason unrelated to declared scope, and the test would prove
    // nothing. A code-host write is governed by no communication policy and is
    // exactly what the invariant is for.
    const fileWrite: ModelTool = {
      name: 'github-dd4c4689__create_or_update_file', description: 'Write a file',
      categories: ['dataChanges'],
    } as unknown as ModelTool;
    const res = svc.checkHitlGate(
      [call('github-dd4c4689__create_or_update_file', { path: 'x.ts', content: 'from the diff' })],
      oversight, 3, [fileWrite], 't1', 'a1',
      {
        ...untrusted,
        declaredStep: {
          stepId: 's14', toolName: 'github-dd4c4689__create_or_update_file',
          argumentsAuthored: false,
        },
      },
    );
    return res.then((r) => {
      expect(r.shouldGate).toBe(true);
      expect(r.reason).toBe('external_content_write');
    });
  });

  it('STILL gates an unclassified write with authored arguments it did not declare', () => {
    // The exemption needs the step to be dispatching ITS tool.
    const res = svc.checkHitlGate(
      [call('agent_slack__slack_delete_message', { channel: 'C1', ts: '1' })],
      oversight, 3, [{ name: 'agent_slack__slack_delete_message', description: 'Delete' } as unknown as ModelTool],
      't1', 'a1', { ...untrusted, declaredStep: s11 },
    );
    return res.then((r) => expect(r.shouldGate).toBe(true));
  });
});

