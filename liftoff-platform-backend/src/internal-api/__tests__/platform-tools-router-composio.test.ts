// C6 regression: when tenant-runtime's new in-process composio-dispatcher
// reports a call via reportComposioToolCall, the platform-tools-router
// endpoint at POST /api/internal/platform-tools/composio-tool-calls writes
// the cost into ingestEventWithBuckets with source='composio_mcp'. From
// there the inline fireOuMeterEvent fires the single
// `operating_unit_consumed` Stripe meter for any post-pay portion.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import { jest } from '@jest/globals';

const mockIngest = jest.fn(async () => 1);
const mockResolveAccountId = jest.fn(async () => 'acct-1');

jest.mock('../../cost-attribution/repository', () => ({
  resolveAccountIdForTenant: (...a: unknown[]) => mockResolveAccountId(...a),
  ingestEventWithBuckets: (...a: unknown[]) => mockIngest(...a),
}));
jest.mock('../../cost-attribution/composio-pricing', () => ({
  COMPOSIO_COST_PER_CALL_USD: 0.000299,
}));

import express from 'express';
import request from 'supertest';
import { platformToolsRouter } from '../platform-tools-router';

const VALID_TOKEN = 'test-platform-callback-token-1234';

describe('POST /api/internal/platform-tools/composio-tool-calls — C6 regression', () => {
  let app: express.Express;
  let originalEnv: string | undefined;

  beforeEach(() => {
    mockIngest.mockReset().mockResolvedValue(1);
    mockResolveAccountId.mockReset().mockResolvedValue('acct-1');
    originalEnv = process.env.PLATFORM_CALLBACK_TOKEN;
    process.env.PLATFORM_CALLBACK_TOKEN = VALID_TOKEN;
    app = express();
    app.use(express.json());
    app.use('/api/internal/platform-tools', platformToolsRouter);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_CALLBACK_TOKEN;
    else process.env.PLATFORM_CALLBACK_TOKEN = originalEnv;
  });

  it('Composio per-call cost flows through ingestEventWithBuckets with source=composio_mcp', async () => {
    const occurredAt = '2026-06-08T12:00:00.000Z';
    const resp = await request(app)
      .post('/api/internal/platform-tools/composio-tool-calls')
      .set('X-Service-Auth', VALID_TOKEN)
      .send({
        calls: [{
          tenantId: '11111111-1111-1111-1111-111111111111',
          agentId: '22222222-2222-2222-2222-222222222222',
          invocationId: '33333333-3333-3333-3333-333333333333',
          callId: 'call-1',
          connectorType: 'google_mail',
          toolName: 'GMAIL_FETCH_EMAILS',
          occurredAt,
        }],
      });

    expect(resp.status).toBe(200);
    expect(mockIngest).toHaveBeenCalledTimes(1);
    const [accountId, sourceId, costUsd, template] = mockIngest.mock.calls[0] as unknown as [
      string, string, number, { source: string; connector: string; purpose: string; eventType: string }
    ];
    expect(accountId).toBe('acct-1');
    expect(sourceId).toContain('11111111');
    expect(costUsd).toBeCloseTo(0.000299);
    expect(template.source).toBe('composio_mcp');
    expect(template.connector).toBe('google_mail');
    expect(template.purpose).toBe('GMAIL_FETCH_EMAILS');
    expect(template.eventType).toBe('connector_call');
  });
});
