// Unit tests for the assert.ts matchers.
//
// Pinning each matcher's semantics here means a regression in the
// assertion logic surfaces in package CI, before it ships to the harness
// runners.

import { assertScenario, matchBareName } from './assert.js';
import type { AgentTestScenario, AgentHarnessRunResult } from './types.js';

function baseResp(over: Partial<AgentHarnessRunResult> = {}): AgentHarnessRunResult {
  return {
    ok: true,
    invocationId: 'inv-1',
    threadId: 'thr-1',
    finalText: 'ok',
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    outcome: 'success',
    exposedToolNames: [],
    durationMs: 1,
    auditLogs: [],
    pauseState: { kind: 'none' },
    ...over,
  };
}

function baseScenario(over: Partial<AgentTestScenario> = {}): AgentTestScenario {
  return {
    id: 'test',
    description: 'test scenario',
    prompt: 'do the thing',
    ...over,
  };
}

describe('matchBareName', () => {
  it('matches identical bare names', () => {
    expect(matchBareName('memory_save', 'memory_save')).toBe(true);
  });

  it('matches MCP-prefixed names by their bare suffix', () => {
    expect(matchBareName('mcp__liftoff-tool-gateway__memory_save', 'memory_save')).toBe(true);
  });

  it('rejects partial suffix matches without the __ delimiter', () => {
    expect(matchBareName('xmemory_save', 'memory_save')).toBe(false);
  });
});

describe('expectsAuditLogContains', () => {
  it('passes when the named action appears in auditLogs', () => {
    const r = assertScenario(
      baseScenario({ expectsAuditLogContains: [{ action: 'memory_save' }] }),
      baseResp({
        auditLogs: [{ id: '1', action: 'memory_save', outcome: 'success', errorCode: null, inputArgs: {} }],
      }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when the named action is missing from auditLogs', () => {
    const r = assertScenario(
      baseScenario({ expectsAuditLogContains: [{ action: 'gmail__send_email' }] }),
      baseResp({ auditLogs: [{ id: '1', action: 'memory_save', outcome: 'success', errorCode: null, inputArgs: {} }] }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/gmail__send_email/);
  });

  it('matches by errorCodeIncludes substring when supplied', () => {
    const r = assertScenario(
      baseScenario({
        expectsAuditLogContains: [{ action: 'gmail__send_email', errorCodeIncludes: 'MISSING_CITATION_URL' }],
      }),
      baseResp({
        auditLogs: [{ id: '1', action: 'gmail__send_email', outcome: 'error', errorCode: 'MISSING_CITATION_URL_AT_SEND', inputArgs: {} }],
      }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when action matches but errorCodeIncludes does not', () => {
    const r = assertScenario(
      baseScenario({
        expectsAuditLogContains: [{ action: 'gmail__send_email', errorCodeIncludes: 'MISSING_CITATION_URL' }],
      }),
      baseResp({
        auditLogs: [{ id: '1', action: 'gmail__send_email', outcome: 'success', errorCode: null, inputArgs: {} }],
      }),
    );
    expect(r.status).toBe('fail');
  });

  it('reports a clear failure when auditLogs is undefined (older runner)', () => {
    const r = assertScenario(
      baseScenario({ expectsAuditLogContains: [{ action: 'memory_save' }] }),
      baseResp({ auditLogs: undefined }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/no auditLogs field/);
  });
});

describe('expectsAuditLogInputArgsNotMatching', () => {
  it('passes when the sanitized input_args do NOT match the regex', () => {
    const r = assertScenario(
      baseScenario({
        expectsAuditLogInputArgsNotMatching: [
          { action: 'memory_save', mustNotMatch: /hunter2/ },
        ],
      }),
      baseResp({
        auditLogs: [{
          id: '1', action: 'memory_save', outcome: 'success', errorCode: null,
          inputArgs: { content: 'remember pi=3.14' },
        }],
      }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when the input_args still contain the credential value', () => {
    const r = assertScenario(
      baseScenario({
        expectsAuditLogInputArgsNotMatching: [
          { action: 'memory_save', mustNotMatch: /eyJhbGc/ },
        ],
      }),
      baseResp({
        auditLogs: [{
          id: '1', action: 'memory_save', outcome: 'success', errorCode: null,
          // Pretend the JWT pattern survived redaction (regression!)
          inputArgs: { note: 'auth = Bearer eyJhbGciOiJIUzI1NiJ9.abc' },
        }],
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/sanitization failed to redact/);
  });

  it('fails clearly when no audit row exists for the named action', () => {
    const r = assertScenario(
      baseScenario({
        expectsAuditLogInputArgsNotMatching: [
          { action: 'memory_save', mustNotMatch: /hunter2/ },
        ],
      }),
      baseResp({ auditLogs: [] }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/no audit_logs row/);
  });
});

describe('expectsHitlPause', () => {
  it('passes when the observed pause kind matches', () => {
    const r = assertScenario(
      baseScenario({ expectsHitlPause: { kind: 'hitl_approval' } }),
      baseResp({ ok: false, pauseState: { kind: 'hitl_approval' } }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when the observed pause kind differs', () => {
    const r = assertScenario(
      baseScenario({ expectsHitlPause: { kind: 'hitl_approval' } }),
      baseResp({ ok: false, pauseState: { kind: 'ask_user' } }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/expected pause kind "hitl_approval"/);
  });

  it('does NOT require ok=true (the agent paused; it never completed)', () => {
    // Without expectsHitlPause, ok=false would fail the run. With it, the
    // ok-gate is short-circuited because the pause is the asserted outcome.
    const r = assertScenario(
      baseScenario({ expectsHitlPause: { kind: 'hitl_approval' } }),
      baseResp({ ok: false, outcome: null, pauseState: { kind: 'hitl_approval' } }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when no pause was observed at all', () => {
    const r = assertScenario(
      baseScenario({ expectsHitlPause: { kind: 'hitl_approval' } }),
      baseResp({ ok: false, pauseState: { kind: 'none' } }),
    );
    expect(r.status).toBe('fail');
  });
});

describe('the ok-gate still trips when expectsHitlPause is absent', () => {
  it('fails when ok=false and there is no pause expectation', () => {
    const r = assertScenario(
      baseScenario(),
      baseResp({ ok: false, outcome: 'error', outcomeReason: 'boom' }),
    );
    expect(r.status).toBe('fail');
    expect(r.failures.join(' ')).toMatch(/did not succeed/);
  });
});
