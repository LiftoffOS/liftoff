// Slack Events API webhook router tests.
//
// Verifies:
//   1. URL verification challenge — echoes `challenge` without any auth
//   2. Signature verification — valid signature passes; invalid / missing
//      / stale timestamp rejected with 401
//   3. Dedup — same event_id processed only once
//   4. Tenant resolution — team_id → connectors row lookup
//   5. Replay window — timestamps older than 5 minutes rejected
//
// We mock withAdminScope so the DB is never touched. Signing-secret env var
// is set per-test.

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import request from 'supertest';

import * as pool from '../db/pool';
import { __setSlackEventPublisher } from './slack-event-publisher';
import type { PubSubPublisher } from '@liftoffos/pubsub';
import { slackEventsRouter, verifySlackSignature } from './slack-webhook-router';

const SIGNING_SECRET = 'test-signing-secret-' + crypto.randomBytes(8).toString('hex');

function makeApp(): express.Express {
  const app = express();
  app.use(
    '/api/connectors/slack/events',
    express.raw({ type: 'application/json' }),
    slackEventsRouter,
  );
  return app;
}

function startServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const app = makeApp();
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function sign(body: string, secret: string, timestampOverride?: number): { ts: string; sig: string } {
  const ts = String(timestampOverride ?? Math.floor(Date.now() / 1000));
  const base = `v0:${ts}:${body}`;
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  return { ts, sig };
}

describe('verifySlackSignature', () => {
  it('accepts a valid signature with a fresh timestamp', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const { ts, sig } = sign(body.toString('utf8'), SIGNING_SECRET);
    expect(verifySlackSignature(body, ts, sig, SIGNING_SECRET)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const { ts, sig } = sign(body.toString('utf8'), SIGNING_SECRET);
    // Flip the last hex nibble to a guaranteed-different value. The old form
    // (`sig.slice(0, -2) + 'ff'`) was flaky ~1/256: when the real HMAC ended in
    // 'ff', the "tampered" signature equalled the valid one and verification
    // correctly returned true, failing the test.
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
    expect(verifySlackSignature(body, ts, tampered, SIGNING_SECRET)).toBe(false);
  });

  it('rejects a timestamp older than 5 minutes', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const stale = Math.floor(Date.now() / 1000) - 301;
    const { ts, sig } = sign(body.toString('utf8'), SIGNING_SECRET, stale);
    expect(verifySlackSignature(body, ts, sig, SIGNING_SECRET)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    expect(verifySlackSignature(body, 'not-a-number', 'v0=ff', SIGNING_SECRET)).toBe(false);
  });

  it('rejects a mismatched body (any byte change invalidates HMAC)', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const { ts, sig } = sign(body.toString('utf8'), SIGNING_SECRET);
    const mutated = Buffer.from(JSON.stringify({ ok: false }));
    expect(verifySlackSignature(mutated, ts, sig, SIGNING_SECRET)).toBe(false);
  });
});

describe('slackEventsRouter — URL verification', () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    const s = await startServer();
    server = s.server;
    url = s.url;
  });
  afterAll((done) => {
    server.close(done);
  });

  it('echoes the challenge without requiring a signature', async () => {
    // URL verification requests are sent ONCE when Slack first configures
    // Event Subscriptions. They are not signed in the standard sense, so
    // the route must accept them before signature checking.
    const res = await request(url)
      .post('/api/connectors/slack/events')
      .set('content-type', 'application/json')
      .send({ type: 'url_verification', challenge: 'abc123', token: 'xxx' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'abc123' });
  });
});

describe('slackEventsRouter — event_callback', () => {
  const OLD_SECRET = process.env.SLACK_SIGNING_SECRET;
  let server: http.Server;
  let url: string;
  let withAdminScopeSpy: jest.SpyInstance;
  const dedupSeen = new Set<string>();
  const connectorsByTeam = new Map<string, { id: string; tenant_id: string }>();
  const publishCalls: Array<{ topic: string; body: Record<string, unknown>; attributes: Record<string, string> }> = [];

  beforeAll(async () => {
    const s = await startServer();
    server = s.server;
    url = s.url;
  });
  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    dedupSeen.clear();
    connectorsByTeam.clear();
    connectorsByTeam.set('T_KNOWN', { id: 'conn-1', tenant_id: 'tenant-1' });
    publishCalls.length = 0;
    const mockPublisher = {
      publish: async (topic: string, body: unknown, options?: { attributes?: Record<string, string> }) => {
        publishCalls.push({ topic, body: body as Record<string, unknown>, attributes: options?.attributes ?? {} });
        return 'msg-id';
      },
    } as unknown as PubSubPublisher;
    __setSlackEventPublisher(mockPublisher);

    // Mock withAdminScope to back the dedup + tenant-resolve queries.
    withAdminScopeSpy = jest.spyOn(pool, 'withAdminScope').mockImplementation(
      (async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => {
        const fakeClient = {
          query: async (sql: string, params: unknown[]) => {
            if (sql.includes('INSERT INTO slack_event_dedup')) {
              const id = params[0] as string;
              if (dedupSeen.has(id)) return { rowCount: 0, rows: [] };
              dedupSeen.add(id);
              return { rowCount: 1, rows: [{ event_id: id }] };
            }
            if (sql.includes('FROM connectors')) {
              const teamId = params[0] as string;
              const row = connectorsByTeam.get(teamId);
              return { rows: row ? [row] : [] };
            }
            throw new Error('unmocked query: ' + sql);
          },
        };
        return fn(fakeClient);
      }) as never,
    );
  });

  afterEach(() => {
    process.env.SLACK_SIGNING_SECRET = OLD_SECRET;
    withAdminScopeSpy.mockRestore();
    __setSlackEventPublisher(null);
  });

  function postSigned(body: Record<string, unknown>, secret = SIGNING_SECRET) {
    const raw = JSON.stringify(body);
    const { ts, sig } = sign(raw, secret);
    return request(url)
      .post('/api/connectors/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', ts)
      .set('x-slack-signature', sig)
      .send(raw);
  }

  it('accepts a properly signed event_callback for a known workspace', async () => {
    const res = await postSigned({
      type: 'event_callback',
      event_id: 'Ev0001',
      team_id: 'T_KNOWN',
      event: { type: 'message', channel: 'C1', text: 'hi', ts: '1717720000.0' },
    });
    expect(res.status).toBe(200);
    // Wait a microtask tick so the fire-and-forget publish resolves.
    await new Promise((r) => setImmediate(r));
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].body).toMatchObject({
      eventId: 'Ev0001',
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
      entityType: 'Message',
      payload: { source: 'slack' },
    });
    expect(publishCalls[0].attributes).toMatchObject({ delivery: 'push', slack_team_id: 'T_KNOWN' });
  });

  it('does not publish for dedup-rejected retries', async () => {
    const body = {
      type: 'event_callback',
      event_id: 'EvDedup',
      team_id: 'T_KNOWN',
      event: { type: 'message', channel: 'C1', text: 'x', ts: '1717720000.0' },
    };
    await postSigned(body);
    await new Promise((r) => setImmediate(r));
    await postSigned(body);
    await new Promise((r) => setImmediate(r));
    expect(publishCalls).toHaveLength(1);
  });

  it('does not publish for unknown workspaces', async () => {
    await postSigned({
      type: 'event_callback',
      event_id: 'EvUnknown',
      team_id: 'T_UNKNOWN',
      event: { type: 'message' },
    });
    await new Promise((r) => setImmediate(r));
    expect(publishCalls).toHaveLength(0);
  });

  it('ack still returns 200 even when publish throws (fire-and-forget)', async () => {
    const failing = {
      publish: async () => {
        throw new Error('pubsub-down');
      },
    } as unknown as PubSubPublisher;
    __setSlackEventPublisher(failing);
    const res = await postSigned({
      type: 'event_callback',
      event_id: 'EvPubFail',
      team_id: 'T_KNOWN',
      event: { type: 'message', ts: '1717720000.0' },
    });
    expect(res.status).toBe(200);
    // Give the unhandled rejection time to surface — should be caught by .catch
    await new Promise((r) => setImmediate(r));
  });

  it('rejects when signature is invalid', async () => {
    const raw = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev0002',
      team_id: 'T_KNOWN',
      event: { type: 'message' },
    });
    const { ts } = sign(raw, SIGNING_SECRET);
    const res = await request(url)
      .post('/api/connectors/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', ts)
      .set('x-slack-signature', 'v0=deadbeef')
      .send(raw);
    expect(res.status).toBe(401);
  });

  it('rejects when signature headers are missing', async () => {
    const res = await request(url)
      .post('/api/connectors/slack/events')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'event_callback', event_id: 'Ev0003', team_id: 'T_KNOWN', event: {} }));
    expect(res.status).toBe(401);
  });

  it('rejects when signing secret is unconfigured', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const res = await postSigned({
      type: 'event_callback',
      event_id: 'Ev0004',
      team_id: 'T_KNOWN',
      event: {},
    });
    expect(res.status).toBe(500);
  });

  it('deduplicates retried events with the same event_id', async () => {
    const body = {
      type: 'event_callback',
      event_id: 'Ev0005',
      team_id: 'T_KNOWN',
      event: { type: 'message', channel: 'C1', text: 'first' },
    };
    const first = await postSigned(body);
    expect(first.status).toBe(200);
    const second = await postSigned(body);
    expect(second.status).toBe(200);
    expect(dedupSeen.has('Ev0005')).toBe(true);
  });

  it('acks 200 and drops events from unknown workspaces (no active connector)', async () => {
    const res = await postSigned({
      type: 'event_callback',
      event_id: 'Ev0006',
      team_id: 'T_UNKNOWN',
      event: { type: 'message' },
    });
    expect(res.status).toBe(200);
  });

  it('acks 200 for envelopes that are not event_callback', async () => {
    const res = await postSigned({
      type: 'app_rate_limited',
      event_id: 'Ev0007',
      team_id: 'T_KNOWN',
    });
    expect(res.status).toBe(200);
  });
});
