// POST /api/chat-media — the door a person's own file comes in through.
//
// What these tests hold: identity is not tenancy, the label on the bytes is not
// the bytes, and a refusal says what is accepted. Every one of them is a
// boundary the composer cannot enforce on its own — the browser chooses the
// Content-Type, the tenant id arrives in the body, and a paste bypasses the
// file input's `accept` list entirely.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockStoreInboundMedia = jest.fn();
const mockClaimInboundMedia = jest.fn();
const mockResolveConnectorAttachments = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: mockGetMembership },
}));
jest.mock('../../media/inbound', () => {
  const actual = jest.requireActual('../../media/inbound');
  return {
    ...actual,
    storeInboundMedia: (...args: unknown[]) => mockStoreInboundMedia(...args),
    claimInboundMedia: (...args: unknown[]) => mockClaimInboundMedia(...args),
  };
});
jest.mock('../connector-resolve', () => ({
  resolveConnectorAttachments: (...args: unknown[]) => mockResolveConnectorAttachments(...args),
}));
// The real authMiddleware verifies a Firebase token against a live Admin SDK.
// Replaced with a pass-through that honours whatever identity the test app set,
// so these tests exercise the ROUTE's own checks — which is where the
// interesting failures are: an authenticated caller naming somebody else's
// tenant is exactly the shape identity alone cannot catch.
jest.mock('../../infrastructure/middleware', () => ({
  authMiddleware: (req: { user?: { uid: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { chatMediaRouter } from '../router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeApp(firebaseUid: string | null = 'uid-1'): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { uid: string } }).user = firebaseUid
      ? { uid: firebaseUid }
      : undefined;
    next();
  });
  app.use('/api/chat-media', chatMediaRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1' });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockStoreInboundMedia.mockResolvedValue({
    mediaId: '33333333-3333-3333-3333-333333333333',
    mimeType: 'image/png',
    filename: 'shot_v1.png',
    sizeBytes: 12,
  });
});

describe('POST /api/chat-media', () => {
  it('stores an allow-listed image and answers with a reference', async () => {
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .field('threadId', THREAD_ID)
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.media.mediaId).toBe('33333333-3333-3333-3333-333333333333');
    // The bytes are never echoed back. What the message carries is a pointer.
    expect(JSON.stringify(res.body)).not.toContain('base64');
  });

  it('401s without a Firebase identity', async () => {
    const res = await request(makeApp(null))
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  // Identity is not tenancy. The tenant id arrives in the BODY, so knowing who
  // is calling says nothing about whether they may act inside it.
  it('403s for somebody who is not in the tenant they named', async () => {
    mockGetMembership.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  // The membership check must come BEFORE the bytes are stored, or a non-member
  // still fills the bucket with objects they are then refused a URL to.
  it('checks membership before storing anything', async () => {
    mockGetMembership.mockResolvedValue(null);
    await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  it('refuses a type it will not store, naming what it accepts', async () => {
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .attach('file', Buffer.from('<svg/>'), {
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
      });

    expect(res.status).toBe(400);
    expect(res.body.details).toContain('image/png');
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  it('rejects a surface it does not know', async () => {
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'somewhere-else')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('accepts an upload with no thread, for a conversation that does not exist yet', async () => {
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'agent_chat')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(mockStoreInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null }),
    );
  });

  it('answers 400 when the bytes are not what the label said', async () => {
    const { MediaContentMismatchError } = jest.requireActual('../../media/inbound');
    mockStoreInboundMedia.mockRejectedValue(new MediaContentMismatchError('image/png'));
    const res = await request(makeApp())
      .post('/api/chat-media')
      .field('tenantId', TENANT_ID)
      .field('surface', 'liftoff')
      .attach('file', Buffer.from('not a png'), {
        filename: 'shot.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not match');
  });
});

describe('POST /api/chat-media/from-connector', () => {
  it('passes the caller through and answers per item', async () => {
    mockResolveConnectorAttachments.mockResolvedValue([
      { externalId: 'a', ok: false, name: 'chart.png', reason: 'that connection can only return text' },
    ]);
    const res = await request(makeApp())
      .post('/api/chat-media/from-connector')
      .send({
        tenantId: TENANT_ID,
        surface: 'liftoff',
        connectorId: '44444444-4444-4444-4444-444444444444',
        connectorType: 'google_drive',
        items: [{ externalId: 'a', name: 'chart.png' }],
      });

    expect(res.status).toBe(200);
    // The refusal is a RESULT, not an error. A pick that cannot be delivered
    // has to come back with a reason the person can read, because the
    // alternative — what happened before — was attaching the filename and
    // letting the model answer from it.
    expect(res.body.results[0]).toMatchObject({ ok: false, reason: expect.any(String) });
  });

  it('403s a non-member before it touches a connector', async () => {
    mockGetMembership.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/chat-media/from-connector')
      .send({
        tenantId: TENANT_ID,
        surface: 'liftoff',
        connectorId: '44444444-4444-4444-4444-444444444444',
        connectorType: 'google_drive',
        items: [{ externalId: 'a', name: 'chart.png' }],
      });
    expect(res.status).toBe(403);
    expect(mockResolveConnectorAttachments).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat-media/claim', () => {
  it('refuses a caller with no service token', async () => {
    const res = await request(makeApp())
      .post('/api/chat-media/claim')
      .send({ tenantId: TENANT_ID, surface: 'team_plan', threadId: THREAD_ID, mediaIds: [THREAD_ID] });
    // 401 without the token, or 503 when the environment has none configured.
    // Either way it is refused, and the claim never runs.
    expect([401, 503]).toContain(res.status);
    expect(mockClaimInboundMedia).not.toHaveBeenCalled();
  });
});
