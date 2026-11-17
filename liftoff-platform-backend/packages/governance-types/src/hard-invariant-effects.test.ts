// Hard invariants, expressed as effects rather than as a list of names.
//
// The two name sets this model sits on top of are precise and incomplete in a
// way a list cannot report. `MERGE_TO_MAIN_TOOL_NAMES` holds three GitHub
// spellings, while the runtime declares four code-collaboration hosts (github,
// gitlab, bitbucket, gitea) and resolves trigger-bound review steps on all of
// them. Three of the four have no merge coverage, and the list looks complete
// because a list always does.
//
// These tests hold two properties the model exists for: every operation the
// platform already treats as always-gating carries an effect (so the two paths
// cannot drift), and the merge rule generalises to hosts nobody enumerated
// without catching the operations that merely mention a merge request.

import {
  hardInvariantEffectOf,
  SUPER_DESTRUCTIVE_OPERATIONS,
  MERGE_TO_MAIN_TOOL_NAMES,
  KNOWN_UNEXPRESSED_EFFECTS,
  WITHDRAWN_BY_SYSTEM,
  ALL_GATE_REASONS,
  ALL_APPROVAL_STATUSES,
  GATE_REASONS,
  APPROVAL_STATUSES,
  type ApprovalStatus,
  type ApprovalDecision,
} from './hitl';

describe('every already-gating operation carries an effect', () => {
  // THE anti-drift ratchet. A new super-destructive operation added without an
  // effect would keep gating via the old name path and be invisible to this
  // one — the half-wired state this model exists to end.
  it.each([...SUPER_DESTRUCTIVE_OPERATIONS])('super-destructive: %s', (op) => {
    expect(hardInvariantEffectOf(op)).toBeDefined();
  });

  it.each([...MERGE_TO_MAIN_TOOL_NAMES])('merge-to-main: %s', (op) => {
    expect(hardInvariantEffectOf(op)).toBe('merge_to_protected_branch');
  });
});

describe('the merge rule reaches hosts nobody enumerated', () => {
  it('covers GitLab, which has no entry in the name set', () => {
    // The gap that motivated the model. GitLab is wired end to end in
    // resolve-trigger-bound-tool.ts — get_merge_request, get_merge_request_diffs,
    // create_merge_request_note — and has no merge coverage at all.
    expect(hardInvariantEffectOf('accept_merge_request')).toBe('merge_to_protected_branch');
    expect(hardInvariantEffectOf('merge_merge_request')).toBe('merge_to_protected_branch');
  });

  it('resolves a namespaced tool name, which is what the dispatcher builds', () => {
    // The catalog registers `<alias>__<fn>`; a raw-name comparison against the
    // model-facing spelling is the prefix defect already fixed at four sites.
    expect(hardInvariantEffectOf('gitlab-1924102e__accept_merge_request'))
      .toBe('merge_to_protected_branch');
    expect(hardInvariantEffectOf('github-dd4c4689__merge_pull_request'))
      .toBe('merge_to_protected_branch');
  });

  it('is case-insensitive on the action', () => {
    expect(hardInvariantEffectOf('MERGE_PULL_REQUEST')).toBe('merge_to_protected_branch');
  });
});

describe('the merge rule does NOT catch operations that merely mention a merge', () => {
  // The trap. A substring match on "merge" gates the reviewer's own commenting
  // step, which is exactly the noise this work exists to remove.
  it.each([
    ['create_merge_request_note', 'posts a comment'],
    ['create_merge_request', 'opens one, does not merge it'],
    ['get_merge_request', 'a read'],
    ['get_merge_request_diffs', 'a read'],
    ['get_merge_request_notes', 'a read'],
    ['list_pull_requests', 'a read'],
    ['add_comment_to_pending_review', 'a comment'],
    ['pull_request_review_write', 'method-dispatched, and never a merge'],
  ])('%s — %s', (name) => {
    expect(hardInvariantEffectOf(name)).toBeUndefined();
  });

  it('does not treat every accept as a merge', () => {
    expect(hardInvariantEffectOf('accept_invitation')).toBeUndefined();
    expect(hardInvariantEffectOf('accept_terms')).toBeUndefined();
  });
});

describe('what undefined means', () => {
  it('is "not one of these", not "safe"', () => {
    // An unclassified tool stays subject to the ordinary category and level
    // gates and to declared scope. Only recognised effects are absolute, which
    // keeps the set auditable rather than fail-closed over everything a code
    // host happens to offer.
    expect(hardInvariantEffectOf('send_email')).toBeUndefined();
    expect(hardInvariantEffectOf('slack-d77db9a0__send_message')).toBeUndefined();
  });

  it('handles an empty or malformed name without throwing', () => {
    expect(hardInvariantEffectOf('')).toBeUndefined();
    expect(hardInvariantEffectOf('__')).toBeUndefined();
    expect(hardInvariantEffectOf('merge')).toBeUndefined();   // verb with no object
  });
});

describe('the gaps are stated rather than silently missing', () => {
  it('names the effects this model cannot yet express', () => {
    // A model listing five effects reads as complete. These are the two it is
    // not, and saying so is the difference between a known gap and a lie.
    expect(KNOWN_UNEXPRESSED_EFFECTS).toEqual(['force_push', 'mass_send']);
  });

  it('does not pretend to recognise them', () => {
    // If a rule for either is ever added, this test fails and forces the entry
    // to be removed from the gap list — the ratchet tightens in both directions.
    for (const name of ['force_push', 'push_force', 'mass_send', 'send_bulk_email']) {
      expect(hardInvariantEffectOf(name)).toBeUndefined();
    }
  });
});

// ── the withdrawn disposition ────────────────────────────────────────────
//
// The other four statuses all make a claim about a person, and for a question
// that should never have been asked, every one of those claims is false.

describe('withdrawn', () => {
  it('is part of the status vocabulary', () => {
    const s: ApprovalStatus = 'withdrawn';
    expect(s).toBe('withdrawn');
  });

  it('names a non-human actor', () => {
    // A withdrawal that recorded a person would recreate the exact lie the
    // value exists to remove.
    expect(WITHDRAWN_BY_SYSTEM).toBe('system:withdrawn');
    expect(WITHDRAWN_BY_SYSTEM.startsWith('system:')).toBe(true);
  });

  it('is not a decision', () => {
    // `decision` stays constrained to approved | rejected in the schema. A
    // withdrawal has no decision, because nobody decided anything — that is the
    // whole point, and conflating the two would put a verdict back on the row.
    const decisions: ApprovalDecision[] = ['approved', 'rejected'];
    expect(decisions).not.toContain('withdrawn' as unknown as ApprovalDecision);
  });
});

// ── the vocabularies the web app duplicates by hand ──────────────────────
//
// liftoff-react has no @liftoffos dependency, so it carries its own hand-typed
// `GateReason` and `ApprovalStatus` in src/services/oversight.ts. Nothing
// reconciles the two copies, and the consequence is specific: the review queue
// maps a reason through a static Record<GateReason, string>, TypeScript checks
// that against the web app's OWN union, and a reason missing there renders an
// EMPTY line exactly where the card says why a person is being asked.
//
// `blast_radius` sat unreachable in two consumers for two minor versions
// without anything noticing. These lists are what makes the next one loud.
describe('the shared vocabularies', () => {
  it('lists every gate reason', () => {
    // ⚠️ ADDING A REASON? liftoff-react carries a hand-typed copy of this union
    // in `src/services/oversight.ts`, plus a `reasonLabels` entry for it. Update
    // BOTH, or the card renders a blank where the reason should be.
    expect([...GATE_REASONS].sort()).toEqual([
      'blast_radius',
      'communication_review',
      'contract_deviation',
      'destructive_gate',
      'external_content_write',
      'level_1_gate',
      'merge_to_main',
      'rate_limit_exceeded',
      'sensitive_work',
      'super_destructive_gate',
    ]);
  });

  it('lists every approval status', () => {
    // ⚠️ Same duplication in liftoff-react's `ApprovalStatus`.
    expect([...APPROVAL_STATUSES].sort()).toEqual([
      'approved', 'expired', 'pending', 'rejected', 'withdrawn',
    ]);
  });

  it('derives the lists from the records rather than restating them', () => {
    // Two hand-written lists in one file would drift from each other, which is
    // the defect this whole pair exists to catch one repo over.
    expect(GATE_REASONS).toHaveLength(Object.keys(ALL_GATE_REASONS).length);
    expect(APPROVAL_STATUSES).toHaveLength(Object.keys(ALL_APPROVAL_STATUSES).length);
  });

  it('covers every reason the gate can actually return', () => {
    // The two invariants that gate before the category path, and the reason the
    // declared-scope work made reachable. If one of these were missing from the
    // union, a gate could return a reason no consumer can name.
    for (const r of ['merge_to_main', 'super_destructive_gate', 'sensitive_work', 'blast_radius', 'contract_deviation']) {
      expect(GATE_REASONS).toContain(r);
    }
  });
});
