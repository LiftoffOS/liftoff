// Proves checkHitlGate's `dryRun` returns the same DECISION but performs NO
// write side effects (rate-limit bookkeeping + policy auto-approve audit) — the
// property sandbox shadow mode relies on to stay observational.

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
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../clients/platform-backend-client', () => ({ fetchOversightSettings: jest.fn() }));

import { HitlEnforcementService } from '../service';
import { insertAuditLog } from '../../audit/service';
import { getGovernanceApprovalPolicy } from '../../governance/governance-service-client';

const mockAudit = insertAuditLog as jest.Mock;
const mockPolicy = getGovernanceApprovalPolicy as jest.Mock;

const oversight: OversightSettings = {
  tenantId: 't1', autonomy: 'balanced', escalation: 'sensitive', communication: 'review',
  sensitiveWork: { customerCommunication: true } as OversightSettings['sensitiveWork'],
} as OversightSettings;
const tools: ModelTool[] = [{ name: 'gmail__send', description: 'Send', categories: ['customerCommunication'] }];
const calls: ToolCallRequest[] = [{ id: '1', name: 'gmail__send', input: {} } as unknown as ToolCallRequest];

describe('checkHitlGate dryRun', () => {
  let svc: HitlEnforcementService;
  beforeEach(() => { svc = new HitlEnforcementService(); jest.clearAllMocks(); mockPolicy.mockResolvedValue(null); });

  it('level 5: dryRun skips recordRateLimitEvent', async () => {
    const spy = jest.spyOn(svc as unknown as { recordRateLimitEvent: () => Promise<void> }, 'recordRateLimitEvent');
    const res = await svc.checkHitlGate(calls, oversight, 5, tools, 't1', 'a1', { dryRun: true });
    expect(res.shouldGate).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('level 5: without dryRun, records rate-limit events', async () => {
    const spy = jest.spyOn(svc as unknown as { recordRateLimitEvent: () => Promise<void> }, 'recordRateLimitEvent').mockResolvedValue(undefined);
    await svc.checkHitlGate(calls, oversight, 5, tools, 't1', 'a1');
    expect(spy).toHaveBeenCalled();
  });

  it('level 3 + standing approval: dryRun returns no-gate WITHOUT the auto-approve audit write', async () => {
    mockPolicy.mockResolvedValue({ decision: 'approved' });
    const res = await svc.checkHitlGate(calls, oversight, 3, tools, 't1', 'a1', { dryRun: true });
    expect(res.shouldGate).toBe(false);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('level 3 + standing approval: without dryRun, writes the auto-approve audit', async () => {
    mockPolicy.mockResolvedValue({ decision: 'approved' });
    const res = await svc.checkHitlGate(calls, oversight, 3, tools, 't1', 'a1');
    expect(res.shouldGate).toBe(false);
    expect(mockAudit).toHaveBeenCalled();
  });
});
