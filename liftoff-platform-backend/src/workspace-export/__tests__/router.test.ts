// The route, mounted with the REAL four-layer chain index.ts uses: the global
// Firebase authMiddleware on /api, requireTenantIdQuery, tenantAuthMiddleware
// ('exportWorkspaceData'), then the router. The order is the thing under test:
// an unauthenticated request is 401 whatever the query string; an
// authenticated request with a missing or malformed tenantId is 400 (never
// 403 or 500); a tenant the caller is not owner or admin of is 403. Then the
// lock, the rate limit, the ceilings, the sources, the headers, the abort, and
// the failure-safe lock cleanup.

import express from 'express';
import request from 'supertest';

const verifyIdToken = jest.fn();
jest.mock('../../infrastructure/firebase', () => ({
  verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
}));
const getMembership = jest.fn();
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: { getMembership: (...a: unknown[]) => getMembership(...a) },
}));
const getByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({ getByFirebaseUid: (...a: unknown[]) => getByFirebaseUid(...a) })),
}));

const clientQuery = jest.fn();
const clientRelease = jest.fn();
const poolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    connect: async () => ({ query: clientQuery, release: clientRelease }),
    query: poolQuery,
  }),
}));

const consume = jest.fn();
jest.mock('rate-limiter-flexible', () => {
  class RateLimiterRes { msBeforeNext = 1000; }
  return {
    RateLimiterPostgres: jest.fn().mockImplementation(() => ({ consume: (...a: unknown[]) => consume(...a) })),
    RateLimiterRes,
  };
});

const logAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: (...a: unknown[]) => logAudit(...a),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  setTraceContext: jest.fn(),
  logError: jest.fn(),
}));
jest.mock('../../infrastructure/tracing', () => ({ getTracer: () => ({ startSpan: () => ({ setAttribute: jest.fn(), end: jest.fn() }) }) }));

const buildWorkspaceExport = jest.fn();
jest.mock('../service', () => ({
  buildWorkspaceExport: (...a: unknown[]) => buildWorkspaceExport(...a),
}));

import { authMiddleware, tenantAuthMiddleware } from '../../infrastructure/middleware';
import { requireTenantIdQuery, workspaceExportRouter, contentDisposition } from '../router';
import { ExportSourceUnavailableError, ExportTooLargeError } from '../budget';
import { RateLimiterRes } from 'rate-limiter-flexible';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const ZIP_BYTES = Buffer.from('zipzipz');

function app() {
  const a = express();
  a.use((req, _res, next) => {
    (req as express.Request).ctx = { requestId: 'r', tenantId: undefined, operation: 'test' } as express.Request['ctx'];
    next();
  });
  // index.ts: the global auth on /api precedes every ordinary mount.
  a.use('/api', (req, res, next) => authMiddleware(req, res, next));
  a.use('/api/workspace-export', requireTenantIdQuery, tenantAuthMiddleware('exportWorkspaceData'), workspaceExportRouter);
  return a;
}

const asRole = (role: string | null) => {
  verifyIdToken.mockResolvedValue({ uid: 'firebase-uid' });
  getByFirebaseUid.mockResolvedValue({ id: ACCOUNT });
  getMembership.mockImplementation(async (tenantId: string) =>
    role && tenantId === TENANT ? { role, tenantId, accountId: ACCOUNT } : null);
};

const ok = () => ({ buffer: ZIP_BYTES, filename: 'northwind-traders-inc-export-2026-09-18.zip', counts: { Conversations: 1 } });

const lockAndUnlock = async (sql: string) =>
  (sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rows: [{ unlocked: true }] });

beforeEach(() => {
  jest.clearAllMocks();
  clientQuery.mockImplementation(lockAndUnlock);
  consume.mockResolvedValue(undefined);
  buildWorkspaceExport.mockResolvedValue(ok());
});

describe('the chain', () => {
  it('401s an unauthenticated request whatever the query string', async () => {
    for (const query of [{ tenantId: TENANT }, {}, { tenantId: 'nope' }]) {
      const res = await request(app()).get('/api/workspace-export').query(query);
      expect(res.status).toBe(401);
    }
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('400s a missing and a malformed tenantId before any membership lookup, never 403 or 500', async () => {
    asRole('owner');
    const missing = await request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t');
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'tenantId is required', code: 'TENANT_ID_REQUIRED' });
    const malformed = await request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t').query({ tenantId: 'not-a-uuid' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'tenantId must be a UUID', code: 'TENANT_ID_INVALID' });
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('403s a member, a viewer, and a foreign tenant', async () => {
    for (const role of ['member', 'viewer']) {
      asRole(role);
      const res = await request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t').query({ tenantId: TENANT });
      expect(res.status).toBe(403);
    }
    asRole('owner');
    const foreign = await request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t').query({ tenantId: OTHER });
    expect(foreign.status).toBe(403);
    expect(buildWorkspaceExport).not.toHaveBeenCalled();
  });

  it('serves the archive to an owner and to an admin with the promised headers and filename', async () => {
    for (const role of ['owner', 'admin']) {
      asRole(role);
      const res = await request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t').query({ tenantId: TENANT })
        .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-length']).toBe(String(ZIP_BYTES.length));
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="northwind-traders-inc-export-2026-09-18.zip"; filename*=UTF-8''northwind-traders-inc-export-2026-09-18.zip`,
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['pragma']).toBe('no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect((res.body as Buffer).toString()).toBe(ZIP_BYTES.toString());
    }
    expect(buildWorkspaceExport).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: TENANT, actor: { accountId: ACCOUNT, role: 'admin' }, asOf: expect.any(Date),
    }));
    expect(logAudit).toHaveBeenCalledWith('compliance.workspace_export_generated',
      expect.objectContaining({ tenantId: TENANT, userId: ACCOUNT }),
      expect.objectContaining({ asOf: expect.any(String), counts: { Conversations: 1 }, bytes: ZIP_BYTES.length, durationMs: expect.any(Number) }));
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('zipzipz');
  });
});

describe('the filename', () => {
  it('carries an ASCII name and a UTF-8 name, and lets no path separator or control character through', () => {
    expect(contentDisposition('workspace-export-2026-09-18.zip'))
      .toBe(`attachment; filename="workspace-export-2026-09-18.zip"; filename*=UTF-8''workspace-export-2026-09-18.zip`);
    const unicode = contentDisposition('liftoff-ünïcode-export.zip');
    expect(unicode).toContain('filename="liftoff-_n_code-export.zip"');
    expect(unicode).toContain(`filename*=UTF-8''liftoff-%C3%BCn%C3%AFcode-export.zip`);
    const traversal = contentDisposition('../evil' + String.fromCharCode(13, 10) + '.zip');
    expect(traversal).not.toMatch(/[\r\n]/);
    expect(traversal).toContain('filename=".._evil__.zip"');
    expect(traversal).toContain(`filename*=UTF-8''..%2Fevil%0D%0A.zip`);
  });
});

describe('the lock, the limit, the ceilings, the sources', () => {
  beforeEach(() => asRole('owner'));
  const get = () => request(app()).get('/api/workspace-export').set('Authorization', 'Bearer t').query({ tenantId: TENANT });

  it('409s while the session lock is held, and releases the client without unlocking what it never locked', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const res = await get();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: 'EXPORT_IN_PROGRESS' });
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][0]).toContain("pg_try_advisory_lock(hashtextextended('workspace-export:' || $1, 0))");
    expect(clientQuery.mock.calls[0][1]).toEqual([TENANT]);
    expect(clientRelease).toHaveBeenCalledWith();
    expect(buildWorkspaceExport).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith('compliance.workspace_export_failed', expect.anything(), { code: 'EXPORT_IN_PROGRESS' });
  });

  it('takes the lock before the rate limit, and releases it exactly once on success and on error', async () => {
    await get();
    const order = clientQuery.mock.calls.map(([sql]) => (sql.includes('try_advisory') ? 'lock' : 'unlock'));
    expect(order).toEqual(['lock', 'unlock']);
    expect(consume.mock.invocationCallOrder[0]).toBeGreaterThan(clientQuery.mock.invocationCallOrder[0]);
    expect(clientQuery.mock.calls[1][0]).toContain("pg_advisory_unlock(hashtextextended('workspace-export:' || $1, 0))");
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(clientRelease).toHaveBeenCalledWith();

    jest.clearAllMocks();
    clientQuery.mockImplementation(lockAndUnlock);
    buildWorkspaceExport.mockRejectedValueOnce(new Error('boom'));
    const failed = await get();
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Export failed', code: 'INTERNAL' });
    expect(clientQuery.mock.calls.filter(([sql]) => sql.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('destroys the connection when the unlock fails, and the next request takes the lock on a fresh one', async () => {
    clientQuery.mockImplementationOnce(async () => ({ rows: [{ locked: true }] }))
      .mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const res = await get();
    expect(res.status).toBe(200);
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(clientRelease.mock.calls[0][0]).toBeInstanceOf(Error);

    jest.clearAllMocks();
    clientQuery.mockImplementationOnce(async () => ({ rows: [{ locked: true }] }))
      .mockImplementationOnce(async () => ({ rows: [{ unlocked: false }] }));
    await get();
    expect(clientRelease.mock.calls[0][0]).toBeInstanceOf(Error);

    jest.clearAllMocks();
    clientQuery.mockImplementation(lockAndUnlock);
    const next = await get();
    expect(next.status).toBe(200);
    expect(clientQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(clientRelease).toHaveBeenCalledWith();
  });

  it('429s the sixth export in the hour, keyed on the workspace and the person', async () => {
    consume.mockRejectedValueOnce(new RateLimiterRes());
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: expect.any(String), code: 'RATE_LIMITED' });
    expect(res.headers['retry-after']).toBe('1');
    expect(consume).toHaveBeenCalledWith(`${TENANT}:${ACCOUNT}`, 1);
    expect(buildWorkspaceExport).not.toHaveBeenCalled();
  });

  it('413s a workspace over the ceiling, before any header', async () => {
    buildWorkspaceExport.mockRejectedValueOnce(new ExportTooLargeError());
    const res = await get();
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: expect.any(String), code: 'EXPORT_TOO_LARGE' });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('503s per source, naming the source and never the upstream URL or message', async () => {
    for (const source of ['tenant_runtime', 'workforce', 'connectors'] as const) {
      buildWorkspaceExport.mockRejectedValueOnce(new ExportSourceUnavailableError(source, new Error('HTTP 502 from https://runtime.internal/api')));
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: expect.any(String), code: 'EXPORT_SOURCE_UNAVAILABLE', source });
      expect(JSON.stringify(res.body)).not.toContain('runtime.internal');
      expect(logAudit).toHaveBeenCalledWith('compliance.workspace_export_failed', expect.anything(), { code: 'EXPORT_SOURCE_UNAVAILABLE', source });
    }
  });

  it('logs an abort when the response closes before it finished, and releases the lock either way', async () => {
    // Drive the handler with a response whose 'close' fires unfinished.
    const handlers: Record<string, () => void> = {};
    const res = {
      status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn(),
      on: jest.fn((event: string, fn: () => void) => { handlers[event] = fn; }),
      end: jest.fn(), writableFinished: false,
    };
    const req = {
      query: { tenantId: TENANT }, ctx: { tenantId: TENANT, requestId: 'r' },
      actorAccountId: ACCOUNT, membership: { role: 'owner' },
    };
    const layer = (workspaceExportRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: (rq: unknown, rs: unknown) => Promise<void> }> } }> })
      .stack.find((l) => l.route?.path === '/')!;
    await layer.route!.stack[0].handle(req, res);
    expect(res.end).toHaveBeenCalled();
    expect(clientQuery.mock.calls.filter(([sql]) => sql.includes('pg_advisory_unlock'))).toHaveLength(1);
    handlers.close();
    expect(logAudit).toHaveBeenCalledWith('compliance.workspace_export_aborted', expect.objectContaining({ tenantId: TENANT }), { bytes: ZIP_BYTES.length });

    jest.clearAllMocks();
    clientQuery.mockImplementation(lockAndUnlock);
    res.writableFinished = true;
    await layer.route!.stack[0].handle(req, res);
    handlers.close();
    expect(logAudit).not.toHaveBeenCalledWith('compliance.workspace_export_aborted', expect.anything(), expect.anything());
  });
});
