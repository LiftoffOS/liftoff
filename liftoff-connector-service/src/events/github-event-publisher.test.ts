// github-event-publisher tests.
//
// Each property below fails SILENTLY when it regresses — a delivered message, a
// green log line, and no agent run:
//
//   1. It publishes onto control-plane-events, not connector-events. The
//      control-project connector-events topic has no tenant-runtime subscriber,
//      so publishing there looks identical to working.
//   2. The vendor body reaches `payload.data` UNRESHAPED, because the runtime's
//      githubEventMatches reads GitHub's native field names off it.
//   3. The dedupe key is the GitHub delivery id, per tenant.
//   4. Actions nobody acts on are not forwarded at all.
//   5. Self-declared permission keys are stripped before the body enters agent
//      context.
//   6. One tenant's publish failure does not cost the other tenants theirs.

const mockFindHolders = jest.fn();
const mockPublishEvent = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../oauth/github-app-pending.js', () => ({
  findTenantsHoldingInstallation: (...a: unknown[]) => mockFindHolders(...a),
}));
jest.mock('./publisher.js', () => ({
  publishEvent: (...a: unknown[]) => mockPublishEvent(...a),
}));
jest.mock('../infra/logging.js', () => ({ logger: mockLogger }));

import { publishGithubWebhookEvent } from './github-event-publisher.js';
import { CONNECTOR_WEBHOOK_EVENT_TYPE } from './connector-webhook-event.js';

// A trimmed but structurally faithful `pull_request` delivery — every field the
// tenant runtime's githubEventMatches reads is present.
const prBody = (over: Record<string, unknown> = {}) => ({
  action: 'opened',
  pull_request: {
    id: 2468,
    number: 42,
    draft: false,
    merged: false,
    user: { login: 'Alex Rivera' },
    head: { ref: 'feature/x', repo: { full_name: 'acme/webapp' } },
    base: { ref: 'main', repo: { full_name: 'acme/webapp' } },
  },
  repository: { full_name: 'acme/webapp' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindHolders.mockResolvedValue([{ tenantId: 'tenant-1', connectorId: 'conn-1' }]);
  mockPublishEvent.mockResolvedValue(undefined);
});

describe('publishGithubWebhookEvent', () => {
  it('publishes connector.webhook_event_received on the control plane, not connector-events', async () => {
    const published = await publishGithubWebhookEvent({
      installationId: 12345678,
      githubEvent: 'pull_request',
      deliveryId: 'delivery-abc',
      body: prBody(),
    });

    expect(published).toBe(1);
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    const call = mockPublishEvent.mock.calls[0][0];
    expect(call.eventType).toBe(CONNECTOR_WEBHOOK_EVENT_TYPE);
    expect(call.eventType).toBe('connector.webhook_event_received');
    expect(call).toMatchObject({
      entityType: 'PullRequest',
      entityId: '2468',
      tenantId: 'tenant-1',
    });
    expect(call.attributes).toMatchObject({
      source: 'github',
      connectorId: 'conn-1',
      delivery: 'push',
      vendorEvent: 'pull_request',
    });
  });

  it('hands the GitHub body to payload.data unreshaped', async () => {
    // The runtime filters on these exact native names. Normalising them away
    // makes a subscription structurally unmatchable while every hop keeps
    // reporting success.
    await publishGithubWebhookEvent({
      installationId: 1,
      githubEvent: 'pull_request',
      deliveryId: 'd1',
      body: prBody(),
    });

    const { payload } = mockPublishEvent.mock.calls[0][0];
    expect(payload.source).toBe('github');
    expect(payload.subtype).toBe('pull_request');
    expect(payload.data).toMatchObject({
      action: 'opened',
      pull_request: {
        draft: false,
        merged: false,
        user: { login: 'Alex Rivera' },
        base: { ref: 'main' },
      },
      repository: { full_name: 'acme/webapp' },
    });
  });

  it('carries the GitHub delivery id as the dedupe key, scoped per tenant', async () => {
    mockFindHolders.mockResolvedValue([
      { tenantId: 'tenant-1', connectorId: 'conn-1' },
      { tenantId: 'tenant-2', connectorId: 'conn-2' },
    ]);

    const published = await publishGithubWebhookEvent({
      installationId: 1,
      githubEvent: 'pull_request',
      deliveryId: 'delivery-abc',
      body: prBody(),
    });

    expect(published).toBe(2);
    const eventIds = mockPublishEvent.mock.calls.map((c) => c[0].payload.eventId);
    expect(eventIds).toEqual(['delivery-abc:tenant-1', 'delivery-abc:tenant-2']);
    // Same entity id though — it is GitHub's, not ours.
    expect(mockPublishEvent.mock.calls.map((c) => c[0].entityId)).toEqual(['2468', '2468']);
  });

  it.each([
    ['opened', true],
    ['synchronize', true],
    ['ready_for_review', true],
    ['reopened', true],
    ['closed', true],
    ['labeled', false],
    ['edited', false],
    ['review_requested', false],
    ['assigned', false],
  ])('pull_request action %s → forwarded=%s', async (action, forwarded) => {
    const published = await publishGithubWebhookEvent({
      installationId: 1,
      githubEvent: 'pull_request',
      deliveryId: 'd1',
      body: prBody({ action }),
    });
    expect(published).toBe(forwarded ? 1 : 0);
    expect(mockPublishEvent).toHaveBeenCalledTimes(forwarded ? 1 : 0);
  });

  it('forwards closed so a merge can reach the pr.merged gate', async () => {
    // GitHub has no `merged` action. The runtime's requireMerged check needs
    // action=closed AND pull_request.merged===true, so dropping `closed` here
    // makes pr.merged permanently unreachable.
    await publishGithubWebhookEvent({
      installationId: 1,
      githubEvent: 'pull_request',
      deliveryId: 'd1',
      body: prBody({ action: 'closed', pull_request: { ...prBody().pull_request, merged: true } }),
    });
    const { payload } = mockPublishEvent.mock.calls[0][0];
    expect(payload.data).toMatchObject({ action: 'closed', pull_request: { merged: true } });
  });

  it('maps issues to entityType Issue and forwards only actionable actions', async () => {
    const issue = (action: string) => ({ action, issue: { id: 999, number: 12 } });

    await publishGithubWebhookEvent({ installationId: 1, githubEvent: 'issues', deliveryId: 'd1', body: issue('opened') });
    expect(mockPublishEvent.mock.calls[0][0]).toMatchObject({ entityType: 'Issue', entityId: '999' });

    jest.clearAllMocks();
    mockFindHolders.mockResolvedValue([{ tenantId: 'tenant-1', connectorId: 'conn-1' }]);
    const published = await publishGithubWebhookEvent({
      installationId: 1, githubEvent: 'issues', deliveryId: 'd2', body: issue('labeled'),
    });
    expect(published).toBe(0);
  });

  it('does not publish GitHub events no catalog row claims', async () => {
    // Every entityType flagged nativeEventDelivery must be forwarded here, and
    // nothing else should be — an event with no catalog row behind it is volume
    // with no consumer.
    for (const githubEvent of ['pull_request_review', 'push', 'workflow_run', 'check_run', 'status']) {
      const published = await publishGithubWebhookEvent({
        installationId: 1, githubEvent, deliveryId: 'd1', body: { action: 'submitted' },
      });
      expect(published).toBe(0);
    }
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it('strips self-declared permission keys before the body enters agent context', async () => {
    await publishGithubWebhookEvent({
      installationId: 1,
      githubEvent: 'pull_request',
      deliveryId: 'd1',
      body: prBody({
        permissions: { admin: true },
        pull_request: { ...prBody().pull_request, body: 'hi', auto_approve: true, bypass_review: true },
      }),
    });

    const data = mockPublishEvent.mock.calls[0][0].payload.data as Record<string, unknown>;
    expect(data.permissions).toBeUndefined();
    const pr = data.pull_request as Record<string, unknown>;
    expect(pr.auto_approve).toBeUndefined();
    expect(pr.bypass_review).toBeUndefined();
    // Real content survives.
    expect(pr.body).toBe('hi');
    expect(pr.number).toBe(42);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'github_webhook_stripped_self_declared_permission_keys',
    );
  });

  it('publishes nothing when no connector row holds the installation', async () => {
    mockFindHolders.mockResolvedValue([]);
    const published = await publishGithubWebhookEvent({
      installationId: 42, githubEvent: 'pull_request', deliveryId: 'd1', body: prBody(),
    });
    expect(published).toBe(0);
    expect(mockPublishEvent).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.anything(),
      'github_webhook_event_no_holding_connector',
    );
  });

  it('one tenant publish failing does not cost the other tenants theirs', async () => {
    mockFindHolders.mockResolvedValue([
      { tenantId: 'tenant-1', connectorId: 'conn-1' },
      { tenantId: 'tenant-2', connectorId: 'conn-2' },
    ]);
    mockPublishEvent.mockRejectedValueOnce(new Error('pubsub-boom'));

    const published = await publishGithubWebhookEvent({
      installationId: 1, githubEvent: 'pull_request', deliveryId: 'd1', body: prBody(),
    });

    expect(published).toBe(1);
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1' }),
      'github_webhook_event_publish_failed',
    );
  });

  it('falls back to the delivery id when the body carries no entity id', async () => {
    await publishGithubWebhookEvent({
      installationId: 1, githubEvent: 'pull_request', deliveryId: 'delivery-xyz',
      body: { action: 'opened', pull_request: { number: 5 } },
    });
    expect(mockPublishEvent.mock.calls[0][0].entityId).toBe('delivery-xyz');
  });
});
