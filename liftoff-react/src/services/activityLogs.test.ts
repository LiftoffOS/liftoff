import { describe, it, expect, vi } from 'vitest'

// canRerunActivityLog is pure, but importing the module pulls in ./api.
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

import { canRerunActivityLog } from './activityLogs'
import type { AgentAuditLog } from './activityLogs'

function log(overrides: Partial<AgentAuditLog>): AgentAuditLog {
  return {
    id: 'l1',
    tenantId: 't1',
    internalAgentId: 'a1',
    userId: null,
    threadId: null,
    invocationId: 'inv1',
    externalAgentId: null,
    action: 'agent_execution',
    inputArgs: {},
    outputSummary: null,
    outcome: 'error',
    errorCode: null,
    triggeredBy: 'cron',
    durationMs: 100,
    createdAt: '2026-07-11T00:00:00Z',
    agentName: 'Team',
    triggeredByAgentName: null,
    proxyKeyId: null,
    preActionSnapshot: null,
    postActionSnapshot: null,
    externalResponse: null,
    snapshotStatus: null,
    ...overrides,
  }
}

describe('canRerunActivityLog (ADR-030 gate)', () => {
  it('true for a failed cron agent_execution', () => {
    expect(canRerunActivityLog(log({ triggeredBy: 'cron' }))).toBe(true)
  })

  it('true for a failed event:* agent_execution', () => {
    expect(canRerunActivityLog(log({ triggeredBy: 'event:campaign-bounce' }))).toBe(true)
  })

  it('false for human:* (chat)', () => {
    expect(canRerunActivityLog(log({ triggeredBy: 'human:uid-123' }))).toBe(false)
  })

  it('false for bare agent (delegated / self-scheduled)', () => {
    expect(canRerunActivityLog(log({ triggeredBy: 'agent' }))).toBe(false)
  })

  it('false for a non-run action row (e.g. a tool call)', () => {
    expect(canRerunActivityLog(log({ action: 'gmail_send_email' }))).toBe(false)
  })

  it('false for a successful run', () => {
    expect(canRerunActivityLog(log({ outcome: 'success' }))).toBe(false)
  })

  it('false for a gated run', () => {
    expect(canRerunActivityLog(log({ outcome: 'gated' }))).toBe(false)
  })

  it('false when internalAgentId is null (external / unmapped)', () => {
    expect(canRerunActivityLog(log({ internalAgentId: null }))).toBe(false)
  })

  it('false when invocationId is null (nothing to re-run)', () => {
    expect(canRerunActivityLog(log({ invocationId: null }))).toBe(false)
  })
})

/** Audit outcome 'gated' is three different things wearing one label.
 *
 *  The runtime writes it for escalated, gated AND paused runs, because
 *  audit_logs.outcome has no wider vocabulary. Only the escalated one has
 *  ended. The other two are live runs waiting on an approval that will resume
 *  by themselves, so offering "Run again" on one would duplicate a person's
 *  work rather than retry it. The error-code marker is the only thing on the
 *  row that separates them.
 */
describe('canRerunActivityLog — escalated runs', () => {
  it('offers Run again on an escalated run, which is the case that most wants it', () => {
    expect(canRerunActivityLog(log({ outcome: 'gated', errorCode: 'escalated' }))).toBe(true)
  })

  it('does not offer it on a run merely waiting for an approval', () => {
    // Same audit outcome, no marker: this run is still live.
    expect(canRerunActivityLog(log({ outcome: 'gated', errorCode: null }))).toBe(false)
  })

  it('does not offer it on a gated run carrying some other error code', () => {
    expect(canRerunActivityLog(log({ outcome: 'gated', errorCode: 'rate_limited' }))).toBe(false)
  })

  it('still applies the trigger rule to an escalated run', () => {
    expect(canRerunActivityLog(
      log({ outcome: 'gated', errorCode: 'escalated', triggeredBy: 'human:uid-1' }),
    )).toBe(false)
  })

  it('still requires an invocation to re-run', () => {
    expect(canRerunActivityLog(
      log({ outcome: 'gated', errorCode: 'escalated', invocationId: null }),
    )).toBe(false)
  })
})
