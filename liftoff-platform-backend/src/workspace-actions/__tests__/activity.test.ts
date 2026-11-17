// activity.ts — the rerun eligibility rule (the Activity page's four
// conditions), the gated relay on a correction, and the role rule.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
const mockGetAuditLog = jest.fn();
const mockListAuditLogs = jest.fn();
jest.mock('../../agent-audit-logs/service', () => ({
  agentAuditLogsService: {
    getAuditLog: (...a: unknown[]) => mockGetAuditLog(...a),
    listAuditLogs: (...a: unknown[]) => mockListAuditLogs(...a),
  },
}));
const mockRequestCorrection = jest.fn();
const mockRequestBulk = jest.fn();
jest.mock('../../corrections/service', () => ({
  correctionService: {
    getCorrectionOptions: jest.fn(async () => ({ correctable: true })),
    requestCorrection: (...a: unknown[]) => mockRequestCorrection(...a),
    requestBulkCorrection: (...a: unknown[]) => mockRequestBulk(...a),
    getCorrectionHistory: jest.fn(async () => []),
  },
}));
const mockRerun = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { rerunFailedRun: (...a: unknown[]) => mockRerun(...a) },
}));
jest.mock('../teams', () => ({
  listAiWorkforce: jest.fn(async () => ({ teams: [{ id: 'agent-1', role: 'Marketing', messagingNickname: null }], collaborators: [] })),
  findTeamByName: jest.requireActual('../teams').findTeamByName,
  teamDisplayName: jest.requireActual('../teams').teamDisplayName,
}));

import { canRerunActivityLog, correct, listActivity, runAgain } from '../activity';
import { PermissionDenied, type Actor } from '../actor';
import type { AgentAuditLog } from '../../agent-audit-logs/types';

const TENANT = '22222222-2222-2222-2222-222222222222';
const ACCOUNT = '77777777-7777-7777-7777-777777777777';
function actor(role: Actor['role']): Actor {
  return { tenantId: TENANT, accountId: ACCOUNT, role, displayName: 'Alice', surface: 'liftoff' };
}

function logRow(over: Partial<AgentAuditLog>): AgentAuditLog {
  return {
    id: 'log-1', tenantId: TENANT, internalAgentId: 'agent-1', userId: null, threadId: null, invocationId: 'inv-1',
    toolCallId: null, externalAgentId: null, proxyKeyId: null, action: 'agent_execution', inputArgs: {},
    outputSummary: null, outcome: 'error', errorCode: null, triggeredBy: 'cron', durationMs: null,
    correctionOf: null, preActionSnapshot: null, postActionSnapshot: null, externalResponse: null,
    snapshotStatus: null, createdAt: new Date(), agentName: 'Marketing', triggeredByAgentName: null,
    ...over,
  } as AgentAuditLog;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRerun.mockResolvedValue({ status: 202, body: { invocationId: 'inv-2' } });
  mockListAuditLogs.mockResolvedValue({ items: [], cursor: null, hasMore: false, total: 0 });
});

describe('canRerunActivityLog', () => {
  it('is the four conditions of the Activity page', () => {
    expect(canRerunActivityLog(logRow({}))).toBe(true);
    expect(canRerunActivityLog(logRow({ triggeredBy: 'event:github.pull_request' }))).toBe(true);
    expect(canRerunActivityLog(logRow({ outcome: 'gated', errorCode: 'escalated' }))).toBe(true);
    // Not a run row; not ended; no team; no invocation; chat- or agent-triggered.
    expect(canRerunActivityLog(logRow({ action: 'tool_call' }))).toBe(false);
    expect(canRerunActivityLog(logRow({ outcome: 'success' }))).toBe(false);
    expect(canRerunActivityLog(logRow({ outcome: 'gated', errorCode: null }))).toBe(false);
    expect(canRerunActivityLog(logRow({ internalAgentId: null }))).toBe(false);
    expect(canRerunActivityLog(logRow({ invocationId: null }))).toBe(false);
    expect(canRerunActivityLog(logRow({ triggeredBy: 'human:chat' }))).toBe(false);
    expect(canRerunActivityLog(logRow({ triggeredBy: 'agent' }))).toBe(false);
  });
});

describe('runAgain', () => {
  it('refuses an ineligible item without calling the runtime, and reruns an eligible one as the person', async () => {
    mockGetAuditLog.mockResolvedValueOnce(logRow({ triggeredBy: 'human:chat' }));
    expect(await runAgain(actor('member'), 'log-1')).toMatchObject({ refused: 'ineligible' });
    expect(mockRerun).not.toHaveBeenCalled();

    mockGetAuditLog.mockResolvedValueOnce(logRow({}));
    const ok = await runAgain(actor('member'), 'log-1');
    expect(ok).toMatchObject({ requested: true, status: 202 });
    expect(mockRerun).toHaveBeenCalledWith(TENANT, 'agent-1', 'inv-1', ACCOUNT);
  });

  it('viewer → 403', async () => {
    await expect(runAgain(actor('viewer'), 'log-1')).rejects.toBeInstanceOf(PermissionDenied);
  });
});

describe('correct', () => {
  it('relays gated with the approval id so the assistant names review_list', async () => {
    mockRequestCorrection.mockResolvedValueOnce({ success: true, status: 'gated', approvalRequestId: 'appr-1' });
    const result = await correct(actor('member'), ['log-1'], 'wrong recipient');
    expect(result).toEqual({ single: { success: true, status: 'gated', approvalRequestId: 'appr-1' } });
    expect(mockRequestCorrection).toHaveBeenCalledWith({ tenantId: TENANT, auditLogId: 'log-1', reason: 'wrong recipient', requestedBy: ACCOUNT });
  });

  it('many ids go through the bulk path (≤50) as the person', async () => {
    mockRequestBulk.mockResolvedValueOnce({ results: [], summary: { total: 2, requested: 2, ineligible: 0, errors: 0 } });
    const result = await correct(actor('admin'), ['a', 'b']);
    expect('bulk' in result).toBe(true);
    expect(mockRequestBulk).toHaveBeenCalledWith(TENANT, ACCOUNT, { auditLogIds: ['a', 'b'], reason: undefined });
  });

  it('viewer → 403 before any service call', async () => {
    await expect(correct(actor('viewer'), ['log-1'])).rejects.toBeInstanceOf(PermissionDenied);
    expect(mockRequestCorrection).not.toHaveBeenCalled();
  });
});

describe('listActivity', () => {
  it('translates a team name to its id and passes the filters through', async () => {
    await listActivity(actor('viewer'), { team: 'marketing', outcome: 'error', q: 'invoice', limit: 5 });
    expect(mockListAuditLogs).toHaveBeenCalledWith(TENANT, { internalAgentId: 'agent-1', outcome: 'error', q: 'invoice' }, 5, undefined);
  });

  it('an unknown team is a refusal, not an unfiltered feed', async () => {
    expect(await listActivity(actor('member'), { team: 'Nobody' })).toMatchObject({ refused: 'unknown_team' });
    expect(mockListAuditLogs).not.toHaveBeenCalled();
  });
});
