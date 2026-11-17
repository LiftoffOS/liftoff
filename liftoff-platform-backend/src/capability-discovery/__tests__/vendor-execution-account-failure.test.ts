// A credential that failed at ACCOUNT level is recognised where it happens,
// and parked under the key the call actually ran on.
//
// Exactly two signals park: the wire's `auth_expired` (connector-service's
// classification of a 401) and an explicit payment-required answer. A
// forbidden resource, a rate limit, an outage, a transport failure and a bad
// argument are all per call and park nothing — and an argument rejection is
// decided FIRST, so a validation message that quotes a status never reads as
// a payment failure. The key is the connector id dispatched on: the platform
// key for a platform run, that one connector for a workspace's own, so two
// connectors of one type in one workspace are two parks.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({ fetchRegistry: jest.fn(), fetchConnectorFunctions: jest.fn() }));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));
jest.mock('../probe-runner', () => ({ elevateBlueprintFromRun: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../vendor-gate', () => ({
  platformVendorSwitchedOff: jest.fn().mockResolvedValue(false),
  isCooling: jest.fn().mockReturnValue(false),
  parkCredential: jest.fn().mockResolvedValue(undefined),
}));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { ingestEventWithBuckets } from '../../cost-attribution/repository';
import { runApifyActor } from '../apify-executor';
import { isCooling, parkCredential } from '../vendor-gate';
import { executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();
const TEN_MINUTES = 10 * 60_000;

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockReset();
  (getCatalog as jest.Mock).mockResolvedValue({
    connectors: [{ type: 'tikhub', status: 'internal' }, { type: 'apify', status: 'internal' }, { type: 'zoho', status: 'available' }],
  });
  (fetchRegistry as jest.Mock).mockResolvedValue(new Map([
    ['tikhub', { connectorType: 'tikhub', functionNames: ['fetch_posts'] }],
    ['zoho', { connectorType: 'zoho', functionNames: ['list_accounts'] }],
  ]));
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['read'], isManualOverride: false, toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([]);
  (isCooling as jest.Mock).mockReturnValue(false);
});

const failure = (error: string, errorCode: string, extra: Record<string, unknown> = {}) =>
  ({ success: false, error, errorCode, costUsd: 0, fundingSource: 'platform_key', ...extra });

const tikhub = (accountId = '') =>
  executeVendorTool({ tenantId: 't1', accountId, connectorType: 'tikhub', toolName: 'fetch_posts', args: { q: 'x' }, caller: 'assistant' });

describe('a registry function that fails at account level', () => {
  it('a 401 the wire classified auth_expired parks the platform key, reason auth', async () => {
    executeMock.mockResolvedValue(failure('tikhub.fetch_posts: tikhub /api/x returned 401', 'auth_expired'));
    const out = await tikhub();
    expect(out).toEqual({ success: false, reason: 'tikhub.fetch_posts: tikhub /api/x returned 401', accountFailure: 'auth' });
    expect(parkCredential).toHaveBeenCalledWith({
      credentialRef: 'internal:tikhub', connectorType: 'tikhub', tenantId: null, reason: 'auth', durationMs: TEN_MINUTES,
    });
  });

  it('an explicit 402 in the message the wire could not classify parks the platform key, reason payment', async () => {
    executeMock.mockResolvedValue(failure('tikhub.fetch_posts: tikhub /api/x returned 402', 'internal_error'));
    const out = await tikhub();
    expect(out).toMatchObject({ success: false, accountFailure: 'payment' });
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'internal:tikhub', reason: 'payment', tenantId: null }));
  });

  it.each([
    ['insufficient balance', 'insufficient balance to complete the request', ''],
    ['payment required', 'Payment Required', 'internal_error'],
    ['a strale HTTP 402', 'strale.search_posts: strale search_posts failed: HTTP 402 Payment Required', 'internal_error'],
    ['a strale bare status', 'strale.search_posts: strale search_posts failed: 402 Your balance is empty', 'internal_error'],
    ['a status in parentheses', 'gloria.get_news: premium call failed (402)', 'internal_error'],
    ['a vendor error code', 'strale.search_posts: strale search failed: insufficient_credits', 'internal_error'],
    ['a vendor error code with a status word', 'strale.search_posts: strale search failed: payment_required', 'internal_error'],
  ])('a payment message (%s) parks as payment', async (_label, message, code) => {
    executeMock.mockResolvedValue(failure(message, code));
    expect(await tikhub()).toMatchObject({ accountFailure: 'payment' });
  });

  it.each([
    ['a 403 on a private profile', 'tikhub /api/x returned 403: profile is private', 'permission_denied'],
    ['a 429', 'too many requests', 'rate_limited'],
    ['a 500', 'tikhub /api/x returned 500', 'vendor_unavailable'],
    ['a 404', 'user not found', 'not_found'],
    ['an unclassified failure with no payment wording', 'something went wrong', 'internal_error'],
    ['a payment word under a code the wire DID classify', 'insufficient balance on 402', 'permission_denied'],
    // "402" where it is not a status: an id, a count, a line. The number is
    // read only where a status is written.
    ['a bare 402 that is not a status', 'tikhub.fetch_posts: order 402 not found in the export', 'internal_error'],
    ['a 402 as a count', 'tikhub.fetch_posts: 402 items exceed the page limit', 'internal_error'],
  ])('does not park on %s', async (_label, message, code) => {
    executeMock.mockResolvedValue(failure(message, code));
    const out = await tikhub();
    expect(out).toEqual({ success: false, reason: message });
    expect(parkCredential).not.toHaveBeenCalled();
  });

  it('a 400 validation message that quotes a status is an argument rejection, not an account failure', async () => {
    executeMock.mockResolvedValue(failure(
      'Invalid request data provided\n- Input should be a valid string on parameter `fields` (see 402 docs)', 'internal_error',
    ));
    const out = await tikhub();
    expect(out).toMatchObject({ success: false, argumentsRejected: true });
    expect(out).not.toHaveProperty('accountFailure');
    expect(parkCredential).not.toHaveBeenCalled();
  });

  it('a transport failure parks nothing', async () => {
    executeMock.mockRejectedValue(new Error('ECONNRESET'));
    const out = await tikhub();
    expect(out).toEqual({ success: false, reason: 'the vendor call failed; see logs' });
    expect(parkCredential).not.toHaveBeenCalled();
  });
});

describe('the key is the credential the call ran on', () => {
  const zoho = (accountId: string) =>
    executeVendorTool({ tenantId: 't1', accountId, connectorType: 'zoho', toolName: 'list_accounts', args: {}, caller: 'caio' });

  it('a workspace connector parks THAT connector, attributed to the tenant — and a second connector of the type is untouched', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([
      { id: 'conn-zoho-1', type: 'zoho', status: 'active' },
      { id: 'conn-zoho-2', type: 'zoho', status: 'active' },
    ]);
    executeMock.mockResolvedValue(failure('zoho returned 401', 'auth_expired', { fundingSource: 'tenant_key' }));
    await zoho('acct-7');
    // The first positively connected connector of the type is the one dispatched on and the one parked.
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-zoho-1' }), undefined);
    expect(parkCredential).toHaveBeenCalledTimes(1);
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'connector:conn-zoho-1', connectorType: 'zoho', tenantId: 't1', reason: 'auth' }));
  });

  it('a placeholder row is not a credential: the platform key is dispatched on and parked', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-tikhub-x', type: 'tikhub', status: 'reconnect_required' }]);
    executeMock.mockResolvedValue(failure('returned 402', 'internal_error'));
    await tikhub('acct-7');
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'internal:tikhub' }), undefined);
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'internal:tikhub', tenantId: null }));
  });

  it('a cooling credential is skipped before the registry, the gate and transport — nothing is dispatched', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-zoho-1', type: 'zoho', status: 'active' }]);
    (isCooling as jest.Mock).mockImplementation((ref: string) => ref === 'connector:conn-zoho-1');
    const out = await zoho('acct-7');
    expect(out).toEqual({ success: false, skipped: 'cooling', reason: expect.stringContaining('connector:conn-zoho-1') });
    expect(executeMock).not.toHaveBeenCalled();
    expect(fetchRegistry).not.toHaveBeenCalled();
    // The platform key of the same type is a different credential and still runs.
    (isCooling as jest.Mock).mockImplementation((ref: string) => ref === 'internal:zoho');
    executeMock.mockResolvedValue({ success: true, result: { items: [1] }, costUsd: 0, fundingSource: 'tenant_key' });
    expect(await zoho('acct-7')).toMatchObject({ success: true });
  });
});

describe('the platform Apify account', () => {
  const runActor = () =>
    executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'apify', toolName: 'run_actor',
      args: {}, presetArgs: { actorId: 'someone/actor' }, caller: 'assistant',
    });

  it('a 401 on the platform start call parks internal:apify as auth', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([]);
    (runApifyActor as jest.Mock).mockResolvedValue({ success: false, error: 'the source returned an error (401)', accountFailure: 'auth' });
    const out = await runActor();
    expect(out).toEqual({ success: false, reason: 'the source returned an error (401)', accountFailure: 'auth' });
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'internal:apify', connectorType: 'apify', tenantId: null, reason: 'auth' }));
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a workspace with its own Apify account runs there first, booked tenant_key, and the platform is never called', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-apify-1', type: 'apify', status: 'active' }]);
    executeMock.mockResolvedValue({ success: true, result: { runId: 'run-own', datasetId: 'ds', items: [{ a: 1 }] }, costUsd: 0.02, fundingSource: 'tenant_key', errorCode: '', error: '' });
    const out = await runActor();
    expect(out).toMatchObject({ success: true, costUsd: 0.02, vendorRunRef: 'apify:run:run-own' });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const req = executeMock.mock.calls[0][0] as { connectorId: string; functionName: string; input: Record<string, unknown> };
    expect(req.connectorId).toBe('conn-apify-1');
    expect(req.functionName).toBe('run_actor');
    expect(req.input).toMatchObject({ actorId: 'someone/actor', maxItems: 100 });
    expect(runApifyActor).not.toHaveBeenCalled();
    // Booked on the workspace's own money: the BYOK path, no OUs for the vendor part.
    expect(ingestEventWithBuckets).toHaveBeenCalledWith(expect.any(String), 'apify:run:run-own', 0.02, expect.objectContaining({ byokFunded: true, connector: 'apify' }));
  });

  it('when the workspace\'s own account refuses the key, that connector is parked and the platform rungs take the run', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-apify-1', type: 'apify', status: 'active' }]);
    executeMock.mockResolvedValue({ success: false, result: {}, costUsd: 0, fundingSource: '', errorCode: 'auth_expired', error: 'apify refused the run: token-not-valid: bad token' });
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [{ b: 2 }], costUsd: 0.01, runId: 'run-platform', fundingSource: 'x402_wallet' });
    const out = await runActor();
    expect(out).toMatchObject({ success: true, vendorRunRef: 'apify:run:run-platform' });
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'connector:conn-apify-1', connectorType: 'apify', tenantId: 't1', reason: 'auth' }));
    expect(runApifyActor).toHaveBeenCalledTimes(1);
  });

  it('a workspace account that is cooling is skipped straight to the platform rungs', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-apify-1', type: 'apify', status: 'active' }]);
    (isCooling as jest.Mock).mockImplementation((ref: string) => ref === 'connector:conn-apify-1');
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [], costUsd: undefined, runId: 'run-p2', fundingSource: 'platform_key' });
    expect(await runActor()).toMatchObject({ success: true });
    expect(executeMock).not.toHaveBeenCalled();
    expect(runApifyActor).toHaveBeenCalledTimes(1);
  });

  it('a 402 on the start call parks internal:apify as payment', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: false, error: 'the source returned an error (402)', accountFailure: 'payment' });
    expect(await runActor()).toMatchObject({ accountFailure: 'payment' });
    expect(parkCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'internal:apify', reason: 'payment' }));
  });

  it('is skipped before the vendor call while internal:apify is cooling', async () => {
    (isCooling as jest.Mock).mockImplementation((ref: string) => ref === 'internal:apify');
    expect(await runActor()).toMatchObject({ success: false, skipped: 'cooling' });
    expect(runApifyActor).not.toHaveBeenCalled();
  });

  it('an ambiguous or started-then-failed run is not safe to fail over from, and its charge is booked under its own key', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({
      success: false, error: 'the source returned an error (run FAILED)', runId: 'run-bad', autoFailoverSafe: false, costUsd: 0.0005,
    });
    const out = await runActor();
    expect(out).toEqual({ success: false, reason: 'the source returned an error (run FAILED)', autoFailoverSafe: false });
    expect(parkCredential).not.toHaveBeenCalled();
    expect(ingestEventWithBuckets).toHaveBeenCalledWith('acct-1', 'apify:run:run-bad', 0.0005, expect.objectContaining({ connector: 'apify' }));
  });

  it('a definite pre-start failure with no run stays safe to fail over from and books nothing', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: false, error: 'the source returned an error (404)' });
    const out = await runActor();
    expect(out).toEqual({ success: false, reason: 'the source returned an error (404)' });
    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
  });
});

describe('a charge the vendor reported is booked whether or not the call answered', () => {
  it('books a registry call that failed but was charged, under that attempt\'s own key', async () => {
    executeMock.mockResolvedValue(failure('tikhub /api/x returned 500', 'vendor_unavailable', { costUsd: 0.002 }));
    await executeVendorTool({
      tenantId: 't1', accountId: '', connectorType: 'tikhub', toolName: 'fetch_posts', args: {}, caller: 'assistant', idempotencyKey: 'attempt-key-1',
    });
    expect(ingestEventWithBuckets).toHaveBeenCalledWith('acct-1', 'attempt-key-1', 0.002, expect.objectContaining({ connector: 'tikhub', actionType: 'fetch_posts' }));
  });

  it('books an empty answer that was charged', async () => {
    executeMock.mockResolvedValue({ success: true, result: { items: [] }, costUsd: 0.001, fundingSource: 'platform_key' });
    await tikhub();
    expect(ingestEventWithBuckets).toHaveBeenCalledWith('acct-1', expect.any(String), 0.001, expect.any(Object));
  });

  it('books nothing when the vendor reported no charge', async () => {
    executeMock.mockResolvedValue(failure('tikhub /api/x returned 500', 'vendor_unavailable'));
    await tikhub();
    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
  });
});
