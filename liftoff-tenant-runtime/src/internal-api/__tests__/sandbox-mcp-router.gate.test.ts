// Increment A — sandbox connector-dispatch governance gate.
// Proves a connector call made from sandbox code is governed by the SAME
// workspace /oversight evaluation as an LLM tool call, across off|shadow|on,
// and that a gate failure fails-closed when enforcing.

import express from 'express';
import request from 'supertest';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

// --- mocks (hoisted) ---
jest.mock('../middleware/sandbox-jwt-auth', () => ({
  requireSandboxJwt: (req: any, _res: any, next: any) => {
    req.sandboxClaims = { tenantId: TENANT, agentId: AGENT, sandboxId: 'sb-1', instructionVersion: 1 };
    next();
  },
}));

const mockQuery = jest.fn(async (sql: string) => {
  if (sql.includes('mcp_dispatch_counter')) return { rows: [{ mcp_dispatch_counter: 1 }] };
  if (sql.includes('compiled_instructions')) {
    return { rows: [{
      integrations: [{ id: 'int-1', type: 'gmail', alias: 'gmail' }],
      system_prompt: 'You are the Support Assistant for Acme.\n\n## Tone\nWarm.',
      user_instructions: 'Reply to every ticket within the hour.',
      instructions_md: '## Role\nYou are running as the Support Assistant for Acme.\n\n## Tool-use guidance\nRead the ticket first.',
    }] };
  }
  if (sql.includes('connector_manifests')) return { rows: [{ id: 'int-1', alias: 'gmail', connector_type: 'gmail', tool_definitions: [{ name: 'send_email' }] }] };
  return { rows: [] };
});
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../tool-gateway/binding-resolver', () => ({ buildBindingsByType: () => ({}) }));
jest.mock('../../tool-gateway/tools-builder', () => ({ buildToolsForAgent: jest.fn().mockResolvedValue([]) }));
jest.mock('../../instruction-compiler/integration-shape', () => ({ normalizeIntegrationsField: (v: unknown) => v ?? [] }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../tool-gateway/router', () => ({ toolGatewayService: { executeConnectorCall: jest.fn().mockResolvedValue({ success: true, data: { ok: 1 } }) } }));
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchema: jest.fn().mockReturnValue({ name: 'send_email', description: 'Send an email', categories: ['customerCommunication'] }),
}));
// Manifest resolution now mirrors the LLM catalog (getManifestsForAgent) instead
// of a raw connector_manifests query.
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([{ id: 'int-1', alias: 'gmail', connectorType: 'gmail' }]),
  },
}));
jest.mock('../../interactive-chat/connector-utils', () => ({
  deriveAllowedConnectors: (ints: Array<{ id: string; type?: string }>) => ints.map(i => i.type || i.id).filter(Boolean),
}));
const mockCreateApprovalRequest = jest.fn().mockResolvedValue({ id: 'appr-1' });
jest.mock('../../hitl-enforcement/service', () => ({
  hitlEnforcementService: {
    getOversightSettings: jest.fn().mockResolvedValue({ tenantId: TENANT, autonomy: 'balanced', escalation: 'important', communication: 'auto', sensitiveWork: {} }),
    getDefaultHitlLevel: jest.fn().mockReturnValue(3),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
    createApprovalRequest: (...a: unknown[]) => mockCreateApprovalRequest(...a),
  },
}));
const mockCheckAdmission = jest.fn().mockResolvedValue({ allowed: true });
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: mockCheckAdmission })) }));
const mockRecordIntent = jest.fn().mockResolvedValue('action-1');
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({ recordIntent: mockRecordIntent })) }));

const mockCheckMessage = jest.fn().mockResolvedValue({ kind: 'as_today' });
jest.mock('../../tool-gateway/message-check', () => ({ checkMessage: (...a: unknown[]) => mockCheckMessage(...a) }));

import { sandboxMcpRouter } from '../sandbox-mcp-router';
import { toolGatewayService } from '../../tool-gateway/router';
import { hitlEnforcementService } from '../../hitl-enforcement/service';
import { insertAuditLog } from '../../audit/service';

const executeConnectorCall = (toolGatewayService as any).executeConnectorCall as jest.Mock;
const checkHitlGate = hitlEnforcementService.checkHitlGate as jest.Mock;
const getOversightSettings = hitlEnforcementService.getOversightSettings as jest.Mock;

function app() {
  const a = express();
  a.use(express.json());
  a.use(sandboxMcpRouter);
  return a;
}
function dispatch(tool = 'gmail__send_email', args: Record<string, unknown> = { to: 'x' }) {
  return request(app()).post('/mcp/dispatch').send({ tool_name: tool, args });
}

const ORIG = process.env.SANDBOX_HITL_ENFORCEMENT;
afterAll(() => { process.env.SANDBOX_HITL_ENFORCEMENT = ORIG; });
beforeEach(() => {
  jest.clearAllMocks();
  mockCheckMessage.mockResolvedValue({ kind: 'as_today' });
  mockCheckAdmission.mockResolvedValue({ allowed: true });
  checkHitlGate.mockResolvedValue({ shouldGate: false });
  getOversightSettings.mockResolvedValue({ tenantId: TENANT, autonomy: 'balanced', escalation: 'important', communication: 'auto', sensitiveWork: {} });
  executeConnectorCall.mockResolvedValue({ success: true, data: { ok: 1 } });
  mockCreateApprovalRequest.mockResolvedValue({ id: 'appr-1' });
  mockRecordIntent.mockResolvedValue('action-1');
});

describe('sandbox /mcp/dispatch governance gate', () => {
  it('on: gated call → hitl_pending, creates sandbox_code approval, connector NOT executed now', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    checkHitlGate.mockResolvedValue({ shouldGate: true, reason: 'sensitive_work' });
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, hitl_pending: true });
    expect(res.body.idempotency_key).toBeTruthy();
    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'sandbox_code', reason: 'sensitive_work', agentId: AGENT, tenantId: TENANT }),
    );
    expect(executeConnectorCall).not.toHaveBeenCalled();
  });

  it('on: allowed call → 200, connector called once', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
  });

  it('on: admission denied → 402 before HITL, connector + gate NOT called', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    mockCheckAdmission.mockResolvedValue({ allowed: false, reason: 'tenant_suspended' });
    const res = await dispatch();
    expect(res.status).toBe(402);
    expect(checkHitlGate).not.toHaveBeenCalled();
    expect(executeConnectorCall).not.toHaveBeenCalled();
  });

  it('on: the gate judges the call against the run\'s instructions contract from its compiled instruction row', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    await dispatch();
    // The contract check (hitl-enforcement/contract-check.ts) reads the user
    // instructions and the role: instructionsMd's fixed `## Role` section
    // first, then the prompt's identity text.
    expect(checkHitlGate).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), TENANT, AGENT,
      expect.objectContaining({
        contract: {
          kind: 'instructions',
          instructions: 'Reply to every ticket within the hour.',
          role: '## Role\nYou are running as the Support Assistant for Acme.\n\nYou are the Support Assistant for Acme.',
        },
      }),
    );
  });

  it('on: admission receives the connector type (kill-switch coverage)', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    await dispatch();
    expect(mockCheckAdmission).toHaveBeenCalledWith(expect.objectContaining({ connectorType: 'gmail' }));
  });

  it('shadow: gated decision → still executes (200); checkHitlGate dryRun, admission skipped', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'shadow';
    checkHitlGate.mockResolvedValue({ shouldGate: true, reason: 'sensitive_work' });
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
    expect(mockCheckAdmission).not.toHaveBeenCalled();
    expect(checkHitlGate).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), TENANT, AGENT,
      expect.objectContaining({ dryRun: true, contract: expect.objectContaining({ kind: 'instructions' }) }),
    );
  });

  it('off: no gate at all — connector called, gate + admission untouched', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'off';
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
    expect(checkHitlGate).not.toHaveBeenCalled();
    expect(mockCheckAdmission).not.toHaveBeenCalled();
  });

  it('on: gate throws → fail-closed 403 gate_unavailable, connector NOT called', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    checkHitlGate.mockRejectedValue(new Error('db down'));
    const res = await dispatch();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ hitl_required: true, reason: 'gate_unavailable' });
    expect(executeConnectorCall).not.toHaveBeenCalled();
  });

  it('shadow: gate throws → fail-open, connector still called', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'shadow';
    checkHitlGate.mockRejectedValue(new Error('db down'));
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
  });
});

// The Communication setting reads the message on this path too
// (tool-gateway/message-check.ts), with the same mapping as the LLM catalog's
// execute-time wrapper.
describe('sandbox /mcp/dispatch message check', () => {
  const review = { tenantId: TENANT, autonomy: 'balanced', escalation: 'important', communication: 'review', sensitiveWork: { customerCommunication: true }, communicationSemantics: 2 };

  it('runs the check with the tool, its categories, the args, the oversight and the catalog decision', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    getOversightSettings.mockResolvedValue(review);
    mockCheckMessage.mockResolvedValue({ kind: 'send', context: { messageCheck: { setting: 'review', asked: { customerCommunication: 0.01 } } } });
    const res = await dispatch('gmail__send_email', { to: 'x', body: 'Thanks, received.' });
    expect(res.status).toBe(200);
    expect(mockCheckMessage).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'gmail__send_email', categories: ['customerCommunication'], args: { to: 'x', body: 'Thanks, received.' },
      oversight: review, decision: { kind: 'require_approval', reason: 'sensitive_work' }, tenantId: TENANT, agentId: AGENT,
    }));
    // Review, cleared: the connector runs and no approval is created.
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
    expect(mockCreateApprovalRequest).not.toHaveBeenCalled();
  });

  it('Review: any other verdict gates as today, with the verdict on the approval context', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    getOversightSettings.mockResolvedValue(review);
    const context = { messageCheck: { setting: 'review', asked: {}, incomplete: true } };
    mockCheckMessage.mockResolvedValue({ kind: 'as_today', context });
    const res = await dispatch('gmail__send_email', { to: 'x' });
    expect(res.body).toMatchObject({ success: true, hitl_pending: true });
    expect(mockCreateApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ reason: 'sensitive_work', context }));
    expect(executeConnectorCall).not.toHaveBeenCalled();
  });

  it('Auto: an unsafe verdict gates with sensitive_work and the verdict, where today nothing gates', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    const auto = { ...review, communication: 'auto' };
    getOversightSettings.mockResolvedValue(auto);
    const context = { messageCheck: { setting: 'auto', asked: { customerCommunication: 0.9 } } };
    mockCheckMessage.mockResolvedValue({ kind: 'pause', reason: 'sensitive_work', matchedCategory: 'customerCommunication', context });
    const res = await dispatch('gmail__send_email', { to: 'x', body: 'Full refund on the way.' });
    expect(res.body).toMatchObject({ success: true, hitl_pending: true });
    expect(mockCheckMessage.mock.calls[0][0]).toMatchObject({ decision: { kind: 'allow' } });
    expect(mockCreateApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ reason: 'sensitive_work', context }));
    expect(executeConnectorCall).not.toHaveBeenCalled();
  });

  it('Auto: as-today sends', async () => {
    process.env.SANDBOX_HITL_ENFORCEMENT = 'on';
    getOversightSettings.mockResolvedValue({ ...review, communication: 'auto' });
    const res = await dispatch('gmail__send_email', { to: 'x', body: 'hi' });
    expect(res.status).toBe(200);
    expect(executeConnectorCall).toHaveBeenCalledTimes(1);
  });
});
