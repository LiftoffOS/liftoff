// The GitHub webhook is public, and it is load-bearing.
//
// Unlike the Meta and Slack webhook routers this one is not supplementary: when
// a non-owner requests the App, GitHub records a request and returns
// `setup_action=request` with no installation id. An owner approves later, in a
// different browser, as a different person. `installation.created` is the ONLY
// signal that it happened.
//
// Which makes the two properties below the ones worth testing hardest: an
// unsigned request must never be acted on, and an installation that cannot be
// attributed to exactly one workspace must never be bound to a guess. Binding
// one workspace's installation to another hands it write access to real
// repositories.

import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const mockComplete = jest.fn();
const mockFindPending = jest.fn();
const mockPublishEntityEvent = jest.fn();

jest.mock('../github-event-publisher.js', () => ({
  publishGithubWebhookEvent: (...a: unknown[]) => mockPublishEntityEvent(...a),
}));
jest.mock('../../oauth/github-app-bind.js', () => ({
  completeGithubAppInstallation: (...a: unknown[]) => mockComplete(...a),
  recordPendingInstallRequest: jest.fn(),
}));
jest.mock('../../oauth/github-app-pending.js', () => ({
  findTenantsAwaitingInstall: (...a: unknown[]) => mockFindPending(...a),
}));
jest.mock('../../oauth/connector-ops.js', () => ({
  findConnectorByTenantAndType: jest.fn(),
  mergeConnectorConfig: jest.fn().mockResolvedValue(undefined),
  updateConnectorStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../oauth/github-app.js', () => ({
  getInstallation: jest.fn().mockResolvedValue(null),
  listInstallationRepositories: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { githubWebhookRouter } from '../github-webhook-router.js';

const SECRET = 'test-webhook-secret';

function app() {
  const a = express();
  a.use('/api/connectors/github', express.raw({ type: 'application/json' }), githubWebhookRouter);
  return a;
}

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')}`;
}

const INSTALL_CREATED = JSON.stringify({
  action: 'created',
  installation: { id: 999, account: { login: 'acme' } },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  mockComplete.mockResolvedValue({ connectorId: 'c1', accountLogin: 'acme', repositorySelection: 'all' });
  mockPublishEntityEvent.mockResolvedValue(1);
});

afterEach(() => {
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
});

describe('signature verification', () => {
  it('accepts a correctly signed installation.created', async () => {
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', sign(INSTALL_CREATED))
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(mockComplete).toHaveBeenCalledWith({ installationId: 999, source: 'webhook' });
  });

  it('rejects a wrong signature without doing any work', async () => {
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(401);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('rejects a missing signature', async () => {
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(401);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('does not throw on a signature of the wrong LENGTH', async () => {
    // timingSafeEqual throws on a length mismatch rather than returning false.
    // Unhandled, that surfaces as a 500 and reads as "our webhook is broken"
    // rather than "that signature was wrong".
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', 'sha256=tooshort')
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(401);
  });

  it('refuses everything when no secret is configured', async () => {
    // Unconfigured is not the same as unauthorized. Accepting an unverifiable
    // delivery would mean acting on anything the internet posts here.
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', sign(INSTALL_CREATED))
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(503);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe('delivery behaviour', () => {
  it('acknowledges before doing the work, so GitHub does not retry into it', async () => {
    // GitHub retries on a non-2xx and disables a webhook that fails
    // persistently. None of the completion work is something it should wait on.
    mockComplete.mockRejectedValueOnce(new Error('database is down'));

    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', sign(INSTALL_CREATED))
      .set('Content-Type', 'application/json')
      .send(INSTALL_CREATED);

    expect(res.status).toBe(202);
  });

  it('ignores an action it does not handle', async () => {
    const body = JSON.stringify({ action: 'edited', installation: { id: 999 } });
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'installation')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe('entity events reach the publisher', () => {
  // The router HMAC-verified `pull_request` and then dropped it, with nothing
  // failing and nothing logging an error. These pin the branch that forwards
  // it, because its absence is invisible from inside this service.

  const PR_OPENED = JSON.stringify({
    action: 'opened',
    installation: { id: 12345678, account: { login: 'acme' } },
    pull_request: { id: 2468, number: 42, draft: false },
    repository: { full_name: 'acme/webapp' },
  });

  it('forwards a signed pull_request delivery, with the delivery id', async () => {
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'delivery-abc')
      .set('X-Hub-Signature-256', sign(PR_OPENED))
      .set('Content-Type', 'application/json')
      .send(PR_OPENED);

    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(mockPublishEntityEvent).toHaveBeenCalledWith({
      installationId: 12345678,
      githubEvent: 'pull_request',
      deliveryId: 'delivery-abc',
      body: expect.objectContaining({ action: 'opened' }),
    });
  });

  it('forwards issues deliveries too', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 12345678 },
      issue: { id: 111, number: 7 },
    });
    await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'd2')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(mockPublishEntityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ githubEvent: 'issues' }),
    );
  });

  it('never forwards an unsigned delivery', async () => {
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'delivery-abc')
      .set('Content-Type', 'application/json')
      .send(PR_OPENED);

    expect(res.status).toBe(401);
    expect(mockPublishEntityEvent).not.toHaveBeenCalled();
  });

  it('still acknowledges when the publish throws', async () => {
    // GitHub disables a hook that keeps failing. A dropped publish costs one
    // event; a disabled hook costs every future one.
    mockPublishEntityEvent.mockRejectedValueOnce(new Error('pubsub is down'));
    const res = await request(app())
      .post('/api/connectors/github/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'delivery-abc')
      .set('X-Hub-Signature-256', sign(PR_OPENED))
      .set('Content-Type', 'application/json')
      .send(PR_OPENED);

    expect(res.status).toBe(202);
  });
});
