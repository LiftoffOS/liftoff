// The self-wake tables (agent_scheduled_invocations additions, wake_event_delivery, wake_resume_rate,
// wake_wait_sets) are deliberately NON-RLS: they are accessed through the scheduled-execution service
// pool with explicit tenant_id filters, matching agent_scheduled_invocations (224) and
// reactive_subscriptions (226). This asserts migration 328 never enables RLS or defines a policy — a
// regression here would silently break every wake query (the service pool has no row_security context).

import { readFileSync } from 'fs';
import { join } from 'path';

describe('migration 328 self-wake: no RLS', () => {
  const sql = readFileSync(join(__dirname, '..', '..', '..', 'migrations', '328_self_wake.sql'), 'utf8');

  it('never enables row level security', () => {
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it('never creates a policy', () => {
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('creates the new wake tables', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS wake_event_delivery/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS wake_resume_rate/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS wake_wait_sets/);
  });

  it('adds settlement_pending without dropping the existing statuses', () => {
    expect(sql).toMatch(/status IN \('pending', 'resume_inflight', 'settlement_pending', 'fired', 'cancelled', 'errored'\)/);
  });

  it('adds the columns the resume/poll/wait-set/sweep paths depend on', () => {
    for (const col of ['wake_kind', 'wake_spec', 'wake_result', 'origin_trust', 'thread_revision',
      'wake_chain_depth', 'lease_token', 'resume_attempts', 'wake_poll_attempts',
      'bound_subscription_id', 'wait_set_id', 'origin_surface']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
  });

  it('wake_wait_sets carries its own fenced lease + mode + member_total', () => {
    for (const col of ['mode', 'lease_token', 'lease_until', 'member_total', 'wake_result', 'context_ref']) {
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(sql).toMatch(/mode\s+TEXT NOT NULL CHECK \(mode IN \('any', 'all'\)\)/);
  });
});
