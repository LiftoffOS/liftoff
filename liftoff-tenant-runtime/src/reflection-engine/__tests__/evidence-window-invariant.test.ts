/**
 * The relationship between two numbers that must not drift apart.
 *
 * `getEvidenceCounts` reads all-time human_corrections from the counter table,
 * so retention cannot move it. `getRecentEvidenceCounts` still counts live from
 * workflow_escalations, and that is safe ONLY while the recency window sits
 * inside the retention window:
 *
 *   Retention deletes a row when `resolved_at < now - RETENTION_DAYS`, and
 *   `resolved_at >= created_at` always. So deletion implies
 *   `created_at < now - RETENTION_DAYS`, and a row with
 *   `created_at > now - days` cannot have been deleted while
 *   `days <= RETENTION_DAYS`.
 *
 * Widen the window, or narrow retention, and the recent count starts dropping
 * corrections that really happened — the same quiet rewrite of an agent's
 * history that agent_evidence_totals was built to stop for the all-time count.
 * Nothing about that failure is visible at runtime: the query still succeeds and
 * still returns a number, just a smaller one than the truth.
 *
 * This test is the enforcement. It fails at CI, on the commit that breaks the
 * relationship, rather than months later inside the learning loop.
 */
import { RETENTION_DAYS } from '../../agent-execution/escalation-retention';
import { EVIDENCE_RECENCY_WINDOW_DAYS } from '../repository';

describe('recent evidence window versus escalation retention', () => {
  it('keeps the recency window inside the retention window', () => {
    expect(EVIDENCE_RECENCY_WINDOW_DAYS).toBeLessThanOrEqual(RETENTION_DAYS);
  });

  it('holds the values this was reasoned about, so a change is deliberate', () => {
    // Not redundant with the comparison above: these pin the pair, so moving
    // either one lands here and forces the author to read the proof before
    // deciding the new numbers are still safe.
    expect(EVIDENCE_RECENCY_WINDOW_DAYS).toBe(7);
    expect(RETENTION_DAYS).toBe(30);
  });

  it('leaves real headroom rather than sitting on the boundary', () => {
    // Equal windows are technically safe by the proof, but a row resolved the
    // same second it was created would sit exactly on the edge, and any later
    // change to how retention rounds its interval would tip it over. Require
    // the recency window to be comfortably inside.
    expect(EVIDENCE_RECENCY_WINDOW_DAYS * 2).toBeLessThanOrEqual(RETENTION_DAYS);
  });
});
