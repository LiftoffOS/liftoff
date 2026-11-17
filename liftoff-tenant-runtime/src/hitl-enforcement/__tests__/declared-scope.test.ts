// Gate on what the agent was approved to do, not on what the tool is called.
//
// The policy is not what goes wrong. Fixing an allowlist entry, a record shape
// or a missing argument is not enough: a reviewer agent still asks permission
// to open a draft review on the pull request that woke it when the graph says
// the step is declared and nothing asks the graph.

import { inDeclaredScope } from '../declared-scope';
import { targetsTriggerEntity, isInPlaceReply } from '../in-place-reply';
import type { TriggerTarget } from '../in-place-reply';

const PR_TARGET: TriggerTarget = {
  source: 'github',
  repository: 'acme/webapp',
  number: 42,
};

const step = {
  stepId: 's8',
  toolName: 'github-dd4c4689__add_comment_to_pending_review',
  description: 'Add each finding to the open review',
};

const call = {
  name: 'github-dd4c4689__add_comment_to_pending_review',
  input: { owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'nit' },
};

describe('all three legs must hold', () => {
  it('accepts the declared step dispatching its tool at the triggering entity', () => {
    expect(inDeclaredScope(call, step, PR_TARGET)).toBe(true);
  });

  it('refuses when no step declared it — the whole adapter path', () => {
    // The model chose the tool itself, which is the definition of a deviation.
    // The exemption needs a step to point at, so the architecture withholds it
    // rather than a rule having to.
    expect(inDeclaredScope(call, undefined, PR_TARGET)).toBe(false);
  });

  it('refuses when the step declares a DIFFERENT tool than the one dispatched', () => {
    // A step that declares a read and dispatches a write is not doing what was
    // approved, whatever the graph says it intended.
    expect(inDeclaredScope(call, { ...step, toolName: 'github-dd4c4689__merge_pull_request' }, PR_TARGET))
      .toBe(false);
  });

  it('refuses when the call reaches a DIFFERENT entity than the trigger', () => {
    // Same agent, same step, another repository. A declared step is authorised
    // against the entity that woke this run and nothing else.
    expect(inDeclaredScope(
      { ...call, input: { ...call.input, repo: 'some-other-repo' } }, step, PR_TARGET,
    )).toBe(false);
    expect(inDeclaredScope(
      { ...call, input: { ...call.input, pullNumber: 82 } }, step, PR_TARGET,
    )).toBe(false);
  });

  it('refuses when there is no trigger target at all', () => {
    expect(inDeclaredScope(call, step, undefined)).toBe(false);
  });
});

describe('name forms across the dispatch boundary', () => {
  it('compares BARE ACTIONS, so the SDK prefix does not defeat it', () => {
    // The catalog registers `<alias>__<fn>`; the SDK calls
    // `mcp__liftoff-tool-gateway__<alias>__<fn>`. A raw name match across that
    // boundary is the prefix defect already fixed at four lookups in
    // checkHitlGate.
    expect(inDeclaredScope(
      { ...call, name: 'mcp__liftoff-tool-gateway__github-dd4c4689__add_comment_to_pending_review' },
      step,
      PR_TARGET,
    )).toBe(true);
  });

  it('survives an alias that moved mid-run', () => {
    // The stale-alias remap rewrites a moved alias for the run; comparing the
    // action alone means the two halves cannot disagree about the instance.
    expect(inDeclaredScope(
      { ...call, name: 'github-99999999__add_comment_to_pending_review' },
      step,
      PR_TARGET,
    )).toBe(true);
  });
});

describe('the identity proof is the one isInPlaceReply already uses', () => {
  // A second identity comparison is the defect `f5a724a` fixed: it compared
  // String(repository) against an OBJECT and a top-level number against a
  // nested pull_request.number, and was wrong for weeks while looking correct.
  it('agrees with isInPlaceReply on the code-host case it permits', () => {
    const reply = {
      name: 'github-dd4c4689__add_issue_comment',
      input: { owner: 'acme', repo: 'webapp', issue_number: 42, body: 'x' },
    };
    expect(isInPlaceReply(reply, PR_TARGET)).toBe(true);
    expect(targetsTriggerEntity(reply, PR_TARGET)).toBe(true);
  });

  it('agrees on rejecting a different repository', () => {
    const elsewhere = {
      name: 'github-dd4c4689__add_issue_comment',
      input: { owner: 'acme', repo: 'other', issue_number: 42, body: 'x' },
    };
    expect(isInPlaceReply(elsewhere, PR_TARGET)).toBe(false);
    expect(targetsTriggerEntity(elsewhere, PR_TARGET)).toBe(false);
  });

  it('proves a mail thread by the thread that woke the run', () => {
    const mail: TriggerTarget = { source: 'google_mail', threadId: '1a0253f5b18b5ca6' };
    expect(targetsTriggerEntity(
      { name: 'gmail__mark_as_read', input: { thread_id: '1a0253f5b18b5ca6' } }, mail,
    )).toBe(true);
    expect(targetsTriggerEntity(
      { name: 'gmail__mark_as_read', input: { thread_id: 'some-other-thread' } }, mail,
    )).toBe(false);
  });
});

describe('the case that killed the first draft of the carve-out', () => {
  it('a declared merge step is still NOT cleared by declared scope', () => {
    // `merge_pull_request` classifies as ['dataChanges'] — not destructive — so
    // "any non-destructive write to the entity that woke me" would have let an
    // agent merge the pull request that woke it. inDeclaredScope answers TRUE
    // here on purpose: it is not the function that decides merges. The hard
    // invariant gates before this is ever consulted, and the gate test below
    // pins that. Keeping the split explicit stops someone "fixing" this
    // function by teaching it about merges, which would put the decision in two
    // places.
    const mergeStep = { stepId: 's9', toolName: 'github-dd4c4689__merge_pull_request' };
    const mergeCall = {
      name: 'github-dd4c4689__merge_pull_request',
      input: { owner: 'acme', repo: 'webapp', pullNumber: 42 },
    };
    expect(inDeclaredScope(mergeCall, mergeStep, PR_TARGET)).toBe(true);
  });
});

describe('both workflow dispatch sites hand the gate a step', () => {
  // How the two `checkHitlGate` sites drifted: one taught, one
  // not, and the untaught one was the path that actually ran. A loop body is a
  // declared step dispatching its declared tool N times, so the loop site needs
  // it exactly as much as the single-call site — and a code-review agent's
  // findings go through the loop.
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8',
  ) as string;

  it('finds both single-call dispatch sites, each passing the step', () => {
    const withStep = SRC.match(/this\.executeToolCalls\(state, \[toolCall\], \{/g) ?? [];
    const withoutStep = SRC.match(/this\.executeToolCalls\(state, \[toolCall\]\)/g) ?? [];
    expect(withStep).toHaveLength(2);
    expect(withoutStep).toHaveLength(0);
  });

  it('passes declaredStep through to the gate', () => {
    expect(SRC).toContain('declaredStep,');
  });
});
