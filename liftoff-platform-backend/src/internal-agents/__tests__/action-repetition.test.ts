// One run, one outward action.
//
// The quiet cases matter as much as the positives: a rule that fires on a
// legitimate loop, a conditional second post, or a failure fallback is noise,
// and a noisy distiller rule gets deleted.

import { findRepeatedOutwardActions } from '../action-repetition';
import type { WorkflowStep } from '../types';

const step = (over: Partial<WorkflowStep> & { stepId: string }): WorkflowStep => ({
  description: over.description ?? 'a step',
  ...over,
}) as WorkflowStep;

const catalog = new Map<string, { categories?: string[] }>([
  ['crm__create_record', { categories: ['write'] }],
  ['mailer__send_email', { categories: ['outbound'] }],
  ['github-7d07a896__pull_request_read', { categories: ['read'] }],
]);

describe('findRepeatedOutwardActions', () => {
  it('flags two unconditional posts of the same review tool', () => {
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'github-7d07a896__pull_request_read', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'github-7d07a896__pull_request_review_write', onSuccess: 's3' }),
      step({ stepId: 's3', type: 'llm_reason', onSuccess: 's4' }),
      step({ stepId: 's4', toolName: 'github-7d07a896__pull_request_review_write', onSuccess: '' }),
    ], catalog);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      stepId: 's4',
      firstStepId: 's2',
      toolName: 'github-7d07a896__pull_request_review_write',
      cycle: false,
    });
    expect(problems[0].message).toContain('every run performs that outward action twice');
  });

  it('flags a success path that leads back into the outward step', () => {
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's2' }),
      step({ stepId: 's2', type: 'llm_reason', onSuccess: 's1' }),
    ], catalog);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ stepId: 's1', cycle: true });
    expect(problems[0].message).toContain('without bound');
  });

  it('recognises an aliased vendor MCP tool, not just the bare name', () => {
    // Matching only the bare form leaves the rule inert for every connector
    // tool, which is how the level-2 destructive gate failed.
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'github-7d07a896__create_and_submit_pull_request_review', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'github-7d07a896__create_and_submit_pull_request_review', onSuccess: '' }),
    ], catalog);
    expect(problems).toHaveLength(1);
  });

  it('uses the catalog classification when there is one', () => {
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'mailer__send_email', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'mailer__send_email', onSuccess: '' }),
    ], catalog);
    expect(problems).toHaveLength(1);
    expect(problems[0].toolName).toBe('mailer__send_email');
  });

  // ── The cases that must stay quiet ──────────────────────────────────────

  it('says nothing when the second post is conditional', () => {
    // A condition is the author having expressed a choice; second-guessing it
    // turns a real property into noise.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's2' }),
      step({ stepId: 's2', type: 'llm_reason', outputField: 'needsEscalation', onSuccess: 's3' }),
      step({
        stepId: 's3', toolName: 'slack_send_message',
        condition: '$.steps.s2.needsEscalation == true', onSuccess: '', onFailure: '',
      }),
    ], catalog)).toEqual([]);
  });

  it('says nothing when anything on the path between them is conditional', () => {
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's2' }),
      step({ stepId: 's2', type: 'llm_reason', condition: '$.steps.s1.ok == true', onSuccess: 's3', onFailure: '' }),
      step({ stepId: 's3', toolName: 'slack_send_message', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('says nothing when the FIRST post is conditional', () => {
    // Symmetric with the check on later steps. A conditional first post is not
    // guaranteed to happen, so the pair is not guaranteed to double.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', type: 'llm_reason', outputField: 'findings', onSuccess: 's2' }),
      step({
        stepId: 's2', toolName: 'github-7d07a896__pull_request_review_write',
        condition: '$.steps.s1.findings > 0', onSuccess: 's3', onFailure: 's3',
      }),
      step({ stepId: 's3', toolName: 'github-7d07a896__pull_request_review_write', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('the shape a real redistill produced stays quiet', () => {
    // v17 of the Code Reviewer: inline comments per finding (conditional AND
    // looped), then one unconditional summary. Two calls to the same tool, and
    // correct — this is the graph the rule must not reject.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's6', type: 'llm_reason', outputField: 'findings', onSuccess: 's7' }),
      step({
        stepId: 's7', toolName: 'trigger__pr_add_comment',
        condition: '$.steps.s6.findings > 0',
        loop: { over: 'steps.s6.findings' }, onSuccess: 's8', onFailure: 's8',
      }),
      step({ stepId: 's8', type: 'llm_reason', outputField: 'summary', onSuccess: 's9' }),
      step({ stepId: 's9', toolName: 'trigger__pr_add_comment', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('says nothing about a loop — repetition there is declared and bounded', () => {
    expect(findRepeatedOutwardActions([
      step({
        stepId: 's1', toolName: 'github-7d07a896__create_review_comment',
        loop: { over: 'steps.s0.files', maxIterations: 50 }, onSuccess: '',
      }),
    ], catalog)).toEqual([]);
  });

  it('says nothing about a re-post reached only through onFailure', () => {
    // That is a retry, and `retry` exists for it.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's3', onFailure: 's2' }),
      step({ stepId: 's2', toolName: 'slack_send_message', onSuccess: '' }),
      step({ stepId: 's3', type: 'llm_reason', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('says nothing about two DIFFERENT outward tools', () => {
    // Submitting a review and then telling the channel about it is one
    // announcement each, not a repeat. Whether the second is gated on the first
    // is findUngatedAnnouncements' question, not this one's.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'github-7d07a896__pull_request_review_write', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'slack_send_message', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('says nothing about repeated READS', () => {
    // Reading a pull request twice is wasteful, not wrong, and this rule is
    // about what the outside world sees.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'github-7d07a896__pull_request_read', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'github-7d07a896__pull_request_read', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('does not mistake a listing tool for a posting tool', () => {
    // get_review_comments / list_comments contain the word but do not post.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'github-7d07a896__get_review_comments', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'github-7d07a896__get_review_comments', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('says nothing about two posts on separate branches of a condition', () => {
    // Only one of these runs. The walk stops at the conditional step, so
    // neither branch is reported.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', type: 'llm_reason', outputField: 'approved', onSuccess: 's2' }),
      step({
        stepId: 's2', toolName: 'slack_send_message',
        condition: '$.steps.s1.approved == true', onSuccess: '', onFailure: 's3',
      }),
      step({ stepId: 's3', toolName: 'slack_send_message', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('does not follow a dangling onSuccess into an invented repeat', () => {
    // An unresolved reference is findWorkflowStepProblems' to report.
    expect(findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's-missing' }),
      step({ stepId: 's2', toolName: 'slack_send_message', onSuccess: '' }),
    ], catalog)).toEqual([]);
  });

  it('reports each first-occurrence once, not once per pair', () => {
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'slack_send_message', onSuccess: 's3' }),
      step({ stepId: 's3', toolName: 'slack_send_message', onSuccess: '' }),
    ], catalog);
    // s1→s2 and s2→s3. Each walk stops at its first repeat, so the model gets
    // two concrete pairs to fix rather than a combinatorial list.
    expect(problems.map((p) => [p.firstStepId, p.stepId])).toEqual([['s1', 's2'], ['s2', 's3']]);
  });

  it('works with no catalog at all', () => {
    // Distillation can run before a catalog is assembled for a tool; the name
    // patterns must still hold.
    const problems = findRepeatedOutwardActions([
      step({ stepId: 's1', toolName: 'slack_send_message', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 'slack_send_message', onSuccess: '' }),
    ]);
    expect(problems).toHaveLength(1);
  });
});
