// One helper, two ways in, one MediaRef.
//
// The whole point of the attach layer is that media is not implemented four
// times. That claim is only worth anything if the two entry points — a platform
// agent calling in process, and an out-of-process producer coming over HTTP
// through POST /api/generated-files — really do converge on the same function
// and write the same shape. A unit test on either side alone cannot see that:
// it is the seam, which is exactly the class of defect that keeps shipping
// here. So it is asserted directly.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockStoreMediaObject = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withTenantScope: jest.fn(),
  withAdminScope: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../infrastructure/middleware', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../generated-files/gcs-client', () => ({
  generatedFilesBucket: jest.fn(),
}));

jest.mock('../../generated-files/store', () => {
  const actual = jest.requireActual('../../generated-files/store');
  return {
    ...actual,
    storeMediaObject: (...args: unknown[]) => mockStoreMediaObject(...args),
  };
});

// Screening allows by default; one test flips it to a block.
const mockScreen = jest.fn(async () => ({ block: false, decision: {} }));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedContent: (...args: unknown[]) => mockScreen(...(args as [])),
}));

const agentChatAppend = jest.fn(async () => ({ id: 'm-agent' }));
const liftoffAppend = jest.fn(async () => ({ id: 'm-liftoff' }));
const insightsAppend = jest.fn(async () => ({ id: 'm-insights' }));

jest.mock('../../agent-chat/chat-repository', () => ({
  appendMediaMessage: (...args: unknown[]) => agentChatAppend(...(args as [])),
  appendMessage: jest.fn(),
}));
jest.mock('../../liftoff/chat-repository', () => ({
  appendMessage: (...args: unknown[]) => liftoffAppend(...(args as [])),
}));
jest.mock('../../insights/chat-repository', () => ({
  appendMessage: (...args: unknown[]) => insightsAppend(...(args as [])),
}));

const mockInsertAuditLog = jest.fn(async () => ({}));
jest.mock('../../agent-audit-logs/service', () => ({
  agentAuditLogsService: { insertAuditLog: (...args: unknown[]) => mockInsertAuditLog(...(args as [])) },
}));
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../tenant-members', () => ({ tenantMembersService: {} }));

process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-token-123';

import { attachMedia, MEDIA_MESSAGE_TYPE, MediaScreeningRefusedError, UnsupportedMediaTypeError } from '../attach';
import { generatedFilesRouter } from '../../generated-files/router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const THREAD = '33333333-3333-3333-3333-333333333333';

const STORED = {
  id: '44444444-4444-4444-4444-444444444444',
  filename: 'shot_v1.png',
  version: 1,
  gcsPath: 'tenants/x/agents/y/z/shot_v1.png',
  mimeType: 'image/png',
  sizeBytes: 7,
  signedUrl: 'https://storage.example/signed',
};

beforeEach(() => {
  mockStoreMediaObject.mockReset();
  mockStoreMediaObject.mockResolvedValue(STORED);
  mockScreen.mockReset();
  mockScreen.mockResolvedValue({ block: false, decision: {} });
  agentChatAppend.mockClear();
  liftoffAppend.mockClear();
  insightsAppend.mockClear();
  mockInsertAuditLog.mockClear();
  mockInsertAuditLog.mockResolvedValue({});
});

/** A one-pixel PNG, built from the spec so the dimension reader has something
 *  real to read. 7 arbitrary bytes would measure as nothing. */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ── HTTP harness ───────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use('/api/generated-files', generatedFilesRouter);
  return app;
}

async function postMedia(body: {
  mimeType: string;
  filename: string;
  alt?: string;
  surface?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = buildApp();
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const form = new FormData();
      const bytes = body.mimeType === 'image/png' ? pngBytes(1280, 3200) : Buffer.from([1, 2, 3, 4, 5, 6, 7]);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: body.mimeType }), body.filename);
      form.append('agentId', AGENT);
      form.append('tenantId', TENANT);
      form.append('baseName', 'shot');
      form.append('outputType', 'media');
      form.append('conversationId', THREAD);
      if (body.alt) form.append('alt', body.alt);
      if (body.surface) form.append('surface', body.surface);
      fetch(`http://127.0.0.1:${addr.port}/api/generated-files`, {
        method: 'POST',
        headers: { 'x-service-auth': 'test-token-123' },
        body: form,
      })
        .then(async (res) => {
          const json = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── The anti-duplication assertion ─────────────────────────────────────

describe('attachMedia is one implementation, whichever way it is reached', () => {
  it('produces a byte-identical MediaRef in process and over HTTP, on two surfaces', async () => {
    // In process, as a platform agent reaches it.
    await attachMedia({
      surface: 'liftoff',
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: pngBytes(1280, 3200),
      mimeType: 'image/png',
      filename: 'shot.png',
      alt: 'the checkout page',
    });

    // Over HTTP, as the tenant runtime reaches it.
    const res = await postMedia({ mimeType: 'image/png', filename: 'shot.png', alt: 'the checkout page' });
    expect(res.status).toBe(201);

    const liftoffRef = liftoffAppend.mock.calls[0][0] as { media: unknown[] };
    const agentChatRef = agentChatAppend.mock.calls[0][3] as unknown[];

    expect(JSON.stringify(agentChatRef)).toBe(JSON.stringify(liftoffRef.media));
    expect(liftoffRef.media[0]).toEqual({
      mediaId: STORED.id,
      filename: STORED.filename,
      mimeType: 'image/png',
      sizeBytes: STORED.sizeBytes,
      // Measured from the PNG header, because no producer supplies these and
      // without them the transcript jumps when the image loads.
      width: 1280,
      height: 3200,
      alt: 'the checkout page',
    });
  });

  it('types the row it appends, so a picture is not mistaken for a greeting', () => {
    // An untyped, turn-less assistant row has the auto-greeting's exact
    // structural signature, and IS_CONVERSATION_PREDICATE would not count a
    // thread whose only reply was a picture.
    expect(MEDIA_MESSAGE_TYPE).toBe('media');
  });

  it('records the artifact in the audit ledger, as a document upload does', async () => {
    await attachMedia({
      surface: 'agent_chat',
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: pngBytes(10, 20),
      mimeType: 'image/png',
      filename: 'shot.png',
    });
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLog.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      internalAgentId: AGENT,
      action: 'media.attached',
      outcome: 'success',
    });
  });

  it('still delivers the media when the audit write fails', async () => {
    mockInsertAuditLog.mockRejectedValue(new Error('ledger down'));
    await expect(
      attachMedia({
        surface: 'agent_chat',
        tenantId: TENANT,
        threadId: THREAD,
        agentId: AGENT,
        bytes: pngBytes(10, 20),
        mimeType: 'image/png',
        filename: 'shot.png',
      }),
    ).resolves.toMatchObject({ mediaId: STORED.id });
    expect(agentChatAppend).toHaveBeenCalledTimes(1);
  });

  it('writes through the adapter for each surface it is asked for', async () => {
    const input = {
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: Buffer.from([1]),
      mimeType: 'image/png',
      filename: 'shot.png',
    };
    await attachMedia({ ...input, surface: 'agent_chat' });
    await attachMedia({ ...input, surface: 'liftoff' });
    await attachMedia({ ...input, surface: 'insights' });
    expect(agentChatAppend).toHaveBeenCalledTimes(1);
    expect(liftoffAppend).toHaveBeenCalledTimes(1);
    expect(insightsAppend).toHaveBeenCalledTimes(1);
  });

  it('stores the object but appends nothing when there is no thread', async () => {
    await attachMedia({
      surface: 'agent_chat',
      tenantId: TENANT,
      threadId: null,
      agentId: AGENT,
      bytes: Buffer.from([1]),
      mimeType: 'image/png',
      filename: 'shot.png',
    });
    expect(mockStoreMediaObject).toHaveBeenCalledTimes(1);
    expect(agentChatAppend).not.toHaveBeenCalled();
  });
});

describe('the allow-list is enforced in the helper, not per caller', () => {
  it('refuses an SVG in process — executable markup served from a URL the browser renders', async () => {
    await expect(
      attachMedia({
        surface: 'agent_chat',
        tenantId: TENANT,
        threadId: THREAD,
        agentId: AGENT,
        bytes: Buffer.from('<svg onload="alert(1)"/>'),
        mimeType: 'image/svg+xml',
        filename: 'x.svg',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    expect(mockStoreMediaObject).not.toHaveBeenCalled();
  });

  it('refuses an SVG over HTTP, before anything is stored', async () => {
    const res = await postMedia({ mimeType: 'image/svg+xml', filename: 'x.svg' });
    expect(res.status).toBe(400);
    expect(mockStoreMediaObject).not.toHaveBeenCalled();
    expect(agentChatAppend).not.toHaveBeenCalled();
  });

  it('accepts a producer that shouts its MIME or attaches a charset', async () => {
    // A multipart part legitimately carries parameters and any casing. Matching
    // the raw string would refuse `IMAGE/PNG` and `image/png; charset=binary`,
    // both of which are the same allowed type.
    await attachMedia({
      surface: 'agent_chat',
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: pngBytes(4, 4),
      mimeType: 'IMAGE/PNG; charset=binary',
      filename: 'shot.png',
    });
    const storeArg = mockStoreMediaObject.mock.calls[0][0] as { uploadedMimeType: string };
    expect(storeArg.uploadedMimeType).toBe('image/png');
  });
});

describe('the HTTP door reaches the same adapters as an in-process caller', () => {
  it('defaults to team chat when the producer names no surface', async () => {
    const res = await postMedia({ mimeType: 'image/png', filename: 'shot.png' });
    expect(res.status).toBe(201);
    expect(agentChatAppend).toHaveBeenCalledTimes(1);
  });

  it('writes to the surface the producer named', async () => {
    const res = await postMedia({ mimeType: 'image/png', filename: 'shot.png', surface: 'insights' });
    expect(res.status).toBe(201);
    expect(insightsAppend).toHaveBeenCalledTimes(1);
    expect(agentChatAppend).not.toHaveBeenCalled();
  });

  it('refuses a surface that has no adapter', async () => {
    const res = await postMedia({ mimeType: 'image/png', filename: 'shot.png', surface: 'nonsense' });
    expect(res.status).toBe(400);
    expect(mockStoreMediaObject).not.toHaveBeenCalled();
  });

  it('answers a screening refusal as a refusal, not as a server fault', async () => {
    // 500 would tell the producer to retry something that will be refused
    // identically, and would file a policy decision as an outage.
    mockScreen.mockResolvedValue({ block: true, decision: {} });
    const res = await postMedia({ mimeType: 'image/png', filename: 'shot.png' });
    expect(res.status).toBe(422);
    expect(mockStoreMediaObject).not.toHaveBeenCalled();
  });
});

describe('producer-supplied text is screened before it is stored', () => {
  it('screens both the filename and the alt', async () => {
    await attachMedia({
      surface: 'agent_chat',
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: Buffer.from([1]),
      mimeType: 'image/png',
      filename: 'invoice.png',
      alt: 'the invoice total',
    });
    const kinds = mockScreen.mock.calls.map((c: unknown[]) => c[1]);
    expect(kinds).toEqual(['invoice.png', 'the invoice total']);
  });

  it('refuses before storing when screening blocks', async () => {
    mockScreen.mockResolvedValue({ block: true, decision: {} });
    await expect(
      attachMedia({
        surface: 'agent_chat',
        tenantId: TENANT,
        threadId: THREAD,
        agentId: AGENT,
        bytes: Buffer.from([1]),
        mimeType: 'image/png',
        filename: 'ignore-previous-instructions.png',
      }),
    ).rejects.toBeInstanceOf(MediaScreeningRefusedError);
    expect(mockStoreMediaObject).not.toHaveBeenCalled();
  });

  it('collapses a producer filename to one printable line', async () => {
    await attachMedia({
      surface: 'agent_chat',
      tenantId: TENANT,
      threadId: THREAD,
      agentId: AGENT,
      bytes: Buffer.from([1]),
      mimeType: 'image/png',
      filename: 'two\nlines\tand   spaces.png',
    });
    const storeArg = mockStoreMediaObject.mock.calls[0][0] as { originalFilename: string; baseName: string };
    expect(storeArg.originalFilename).toBe('two lines and spaces.png');
    expect(storeArg.baseName).toBe('two lines and spaces');
  });
});
