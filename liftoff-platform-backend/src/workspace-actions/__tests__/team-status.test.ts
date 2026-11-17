// setTeamStatus — the role rule, and the 402 that carries the execution
// guard's own words.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));
const mockGetById = jest.fn();
const mockUpdateStatus = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => mockGetById(...a),
    updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  },
}));
jest.mock('../../internal-agents/required-connector-guard', () => ({
  RequiredConnectorMissingError: class RequiredConnectorMissingError extends Error {
    context: unknown;
    constructor(message: string, context?: unknown) { super(message); this.context = context; }
  },
}));
const mockGuard = jest.fn();
jest.mock('../../billing/execution-guard', () => ({
  checkExecutionAllowed: (...a: unknown[]) => mockGuard(...a),
}));
const mockUpdateQuantity = jest.fn(async () => undefined);
jest.mock('../../billing/subscription-items-service', () => ({
  updateAgentQuantity: (...a: unknown[]) => mockUpdateQuantity(...a),
}));

import { ACTIVATION_LIMIT, _resetActivationLimiter, setTeamStatus } from '../team-status';
import { PermissionDenied, type Actor } from '../actor';
import { logAudit } from '../../infrastructure/logging';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const ACCOUNT = '77777777-7777-7777-7777-777777777777';

function actor(role: Actor['role']): Actor {
  return { tenantId: TENANT, accountId: ACCOUNT, role, displayName: 'Alice', surface: 'insights' };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetActivationLimiter();
  mockGetById.mockResolvedValue({ id: AGENT, status: 'draft' });
  mockUpdateStatus.mockImplementation(async (_id: string, _t: string, status: string) => ({ id: AGENT, status }));
  mockPoolQuery.mockResolvedValue({ rows: [{ account_id: 'ws-account' }] });
  mockGuard.mockResolvedValue({ allowed: true });
});

describe('setTeamStatus', () => {
  it('viewer → 403', async () => {
    await expect(setTeamStatus(actor('viewer'), AGENT, 'active')).rejects.toBeInstanceOf(PermissionDenied);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('member → ok, audited under the person and surface, Stripe quantity synced on crossing active', async () => {
    const result = await setTeamStatus(actor('member'), AGENT, 'active');
    expect(result).toEqual({ agent: { id: AGENT, status: 'active' } });
    expect(mockUpdateStatus).toHaveBeenCalledWith(AGENT, TENANT, 'active', ACCOUNT);
    expect(logAudit).toHaveBeenCalledWith(
      'internal_agent.status_changed',
      { tenantId: TENANT, userId: ACCOUNT, operation: 'insights' },
      expect.objectContaining({ internalAgentId: AGENT, newStatus: 'active', previousStatus: 'draft', surface: 'insights' }),
    );
    expect(mockUpdateQuantity).toHaveBeenCalledWith('ws-account');
  });

  it("402 path returns the guard's reason as the message, and writes nothing", async () => {
    mockGuard.mockResolvedValueOnce({ allowed: false, reason: 'This workspace needs an active plan before a team can start.' });
    const result = await setTeamStatus(actor('admin'), AGENT, 'active');
    expect(result).toEqual({
      refused: 'payment_required',
      message: 'This workspace needs an active plan before a team can start.',
      context: { reason: 'This workspace needs an active plan before a team can start.' },
    });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('pausing never consults the guard', async () => {
    mockGetById.mockResolvedValueOnce({ id: AGENT, status: 'active' });
    const result = await setTeamStatus(actor('member'), AGENT, 'paused');
    expect('agent' in result).toBe(true);
    expect(mockGuard).not.toHaveBeenCalled();
    expect(mockUpdateQuantity).toHaveBeenCalled();
  });

  it('a required connector that was never bound → typed refusal with the guard context', async () => {
    const { RequiredConnectorMissingError } = jest.requireMock('../../internal-agents/required-connector-guard');
    mockUpdateStatus.mockRejectedValueOnce(new RequiredConnectorMissingError('Gmail is required', { connectorType: 'google_mail' }));
    const result = await setTeamStatus(actor('member'), AGENT, 'active');
    expect(result).toEqual({ refused: 'required_connector_missing', message: 'Gmail is required', context: { connectorType: 'google_mail' } });
  });

  it('unknown team → not_found', async () => {
    mockGetById.mockResolvedValueOnce(null);
    expect(await setTeamStatus(actor('member'), AGENT, 'active')).toEqual({ refused: 'not_found', message: 'agent not found' });
  });

  it('activation is rate limited per workspace on every surface; pausing is not', async () => {
    for (let i = 0; i < ACTIVATION_LIMIT.max; i++) {
      expect('agent' in (await setTeamStatus(actor('member'), AGENT, 'active'))).toBe(true);
    }
    const over = await setTeamStatus(actor('admin'), AGENT, 'active');
    expect(over).toEqual({ refused: 'rate_limited', message: 'Too many activation requests, please try again later' });
    expect(mockUpdateStatus).toHaveBeenCalledTimes(ACTIVATION_LIMIT.max);
    // Another workspace has its own window.
    expect('agent' in (await setTeamStatus({ ...actor('member'), tenantId: '33333333-3333-3333-3333-333333333333' }, AGENT, 'active'))).toBe(true);
    // Pausing is never limited.
    expect('agent' in (await setTeamStatus(actor('member'), AGENT, 'paused'))).toBe(true);
  });
});
