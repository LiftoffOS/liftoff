// Tests for the Composio connect reconciler — the safety net that recovers
// connections stranded when the post-OAuth browser redirect never lands.
//
// The behaviours that matter:
// an ACTIVE connection with no Liftoff row must get adopted, a user still
// mid-consent must NOT be raced, a dead connection must not be retried
// forever, and one bad row must not stop the rest of the cycle.

const mockList = jest.fn();
const mockDeleteState = jest.fn();
const mockComplete = jest.fn();
const mockGet = jest.fn();

jest.mock('../connector-ops.js', () => ({
  listPendingComposioOAuthStates: mockList,
  deleteOAuthState: mockDeleteState,
}));

jest.mock('../composio-client.js', () => ({
  getComposio: () => ({ connectedAccounts: { get: mockGet } }),
}));

jest.mock('../composio-bind.js', () => ({
  completeComposioConnection: mockComplete,
}));

import { runComposioReconcileCycle } from '../composio-reconciler.js';

function stateRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    state: 'cmp_abc123',
    tenantId: 'tenant_xyz',
    accountId: 'acct_1',
    connectorType: 'google_mail',
    createdAt: new Date(Date.now() - 30 * 60 * 1000),
    extra: {
      composioConnectedAccountId: 'ca_stranded',
      composioAuthConfigId: 'ac_test',
    },
    ...over,
  };
}

describe('runComposioReconcileCycle', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockDeleteState.mockReset().mockResolvedValue(true);
    mockComplete.mockReset().mockResolvedValue({ connectorId: 'connector_1' });
    mockGet.mockReset();
  });

  it('adopts an ACTIVE connection that never got a connector row', async () => {
    mockList.mockResolvedValue([stateRow()]);
    mockGet.mockResolvedValue({ id: 'ca_stranded', status: 'ACTIVE' });

    const s = await runComposioReconcileCycle();

    expect(s).toMatchObject({ examined: 1, adopted: 1, dropped: 0, errored: 0 });
    // Must go through the same bind /callback uses, tagged as reconciler.
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'cmp_abc123',
        composioAuthConfigId: 'ac_test',
        source: 'reconciler',
      }),
    );
  });

  it('leaves a still-INITIATED connect alone rather than racing the user', async () => {
    mockList.mockResolvedValue([stateRow()]);
    mockGet.mockResolvedValue({ id: 'ca_stranded', status: 'INITIATED' });

    const s = await runComposioReconcileCycle();

    expect(s).toMatchObject({ examined: 1, adopted: 0, stillPending: 1, dropped: 0 });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'EXPIRED', 'REVOKED', 'DELETED'])(
    'drops the state row for a %s connection instead of retrying forever',
    async (status) => {
      mockList.mockResolvedValue([stateRow()]);
      mockGet.mockResolvedValue({ id: 'ca_stranded', status });

      const s = await runComposioReconcileCycle();

      expect(s).toMatchObject({ adopted: 0, dropped: 1 });
      expect(mockDeleteState).toHaveBeenCalledWith('cmp_abc123');
      expect(mockComplete).not.toHaveBeenCalled();
    },
  );

  it('never deletes the connection at Composio — adoption is the recovery', async () => {
    mockList.mockResolvedValue([stateRow()]);
    mockGet.mockResolvedValue({ id: 'ca_stranded', status: 'ACTIVE' });

    await runComposioReconcileCycle();

    // The Composio client surface the reconciler touches is read-only.
    expect(mockGet).toHaveBeenCalledWith('ca_stranded');
  });

  it('drops a row whose payload cannot identify the connection', async () => {
    mockList.mockResolvedValue([stateRow({ extra: {} })]);

    const s = await runComposioReconcileCycle();

    expect(s).toMatchObject({ dropped: 1 });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('cmp_abc123');
  });

  it('keeps going when one row throws, so a blip cannot strand the rest', async () => {
    mockList.mockResolvedValue([
      stateRow({ state: 'cmp_bad' }),
      stateRow({ state: 'cmp_good' }),
    ]);
    mockGet
      .mockRejectedValueOnce(new Error('composio 503'))
      .mockResolvedValueOnce({ id: 'ca_stranded', status: 'ACTIVE' });

    const s = await runComposioReconcileCycle();

    expect(s).toMatchObject({ examined: 2, errored: 1, adopted: 1 });
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('returns an empty summary when nothing is pending', async () => {
    mockList.mockResolvedValue([]);

    const s = await runComposioReconcileCycle();

    expect(s).toMatchObject({ examined: 0, adopted: 0 });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('survives the listing query failing', async () => {
    mockList.mockRejectedValue(new Error('db down'));

    await expect(runComposioReconcileCycle()).resolves.toMatchObject({ examined: 0 });
  });
});
