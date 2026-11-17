/**
 * anchor-intervention-bridge — confirms operator replies route correctly back
 * to Anchor's /agent/respond-to-human-intervention by looking up the
 * vendor_session_id from the audit table.
 */
const poolQueryMock = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => poolQueryMock(...args) }),
}));

const respondToInterventionMock = jest.fn();
jest.mock('../../../browser-sessions/session-vendor-proxy', () => ({
  respondToIntervention: (...args: unknown[]) => respondToInterventionMock(...args),
}));

import { forwardAnchorInterventionResponse } from '../anchor-intervention-bridge';

beforeEach(() => jest.clearAllMocks());

describe('forwardAnchorInterventionResponse', () => {
  it('resolves vendor_session_id from anchor_webhook_events and tenant_id from web_sessions, then forwards', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ vendor_session_id: 'vsid-1' }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't-1' }] });

    await forwardAnchorInterventionResponse('req-42', 'click yes');

    const webhookQuery = poolQueryMock.mock.calls[0];
    expect(webhookQuery[0]).toContain("event_type = 'intervention.requested'");
    expect(webhookQuery[0]).toContain("payload->'data'->>'requestId' = $1");
    expect(webhookQuery[1]).toEqual(['req-42']);

    const tenantQuery = poolQueryMock.mock.calls[1];
    expect(tenantQuery[0]).toContain('FROM web_sessions WHERE vendor_session_id = $1');
    expect(tenantQuery[1]).toEqual(['vsid-1']);

    expect(respondToInterventionMock).toHaveBeenCalledWith('vsid-1', 't-1', 'req-42', 'click yes');
  });

  it('throws when no intervention.requested webhook recorded for the requestId', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await expect(forwardAnchorInterventionResponse('req-missing', 'x'))
      .rejects.toThrow(/no recorded intervention.requested/);
    expect(respondToInterventionMock).not.toHaveBeenCalled();
  });

  it('throws when no web_session exists for the resolved vendor_session_id', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ vendor_session_id: 'orphan' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(forwardAnchorInterventionResponse('req-orphan', 'x'))
      .rejects.toThrow(/no web_session for vendor_session_id/);
    expect(respondToInterventionMock).not.toHaveBeenCalled();
  });
});
