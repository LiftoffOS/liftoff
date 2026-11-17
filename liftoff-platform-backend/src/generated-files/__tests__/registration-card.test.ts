// A registration answers whether a card was appended, and which turn it belongs to.
//
// Both registration routes append the `file_output` message inside a catch
// that logs and continues, and answer 201 with the file id regardless: the
// file exists whether or not the card does. `cardAppended` is what tells the
// caller which of the two it got, and it is true ONLY when the insert
// returned a row — the one signal the runtime may trust about what this
// surface did with the file.
//
// The turn rides in its own column. `turn_id` is unique per assistant row
// (acm_assistant_turn_uniq) and a card is an assistant row, so a card stamped
// with the turn's id would collide with the reply; `produced_in_turn_id`
// (migration 474) is what the attachment-claim check reads.
//
// A connector-native row has no bytes to download, and the card hides its
// Download button only when `downloadUrl` is exactly null — so the attachment
// says null, never nothing.

import express from 'express';

const mockWithTenantScope = jest.fn();
const mockClientQuery = jest.fn();
const mockAppendMessage = jest.fn();
const mockStoreMediaObject = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withAdminScope: jest.fn(),
  withTenantScope: (
    tenantId: string,
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => mockWithTenantScope(tenantId, fn),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/middleware', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../gcs-client', () => ({ generatedFilesBucket: jest.fn() }));
jest.mock('../../agent-chat/chat-repository', () => ({
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
}));
jest.mock('../../agent-audit-logs/service', () => ({
  agentAuditLogsService: { insertAuditLog: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../tenant-members', () => ({ tenantMembersService: {} }));
jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  storeMediaObject: (...args: unknown[]) => mockStoreMediaObject(...args),
}));

process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-token-123';

import { generatedFilesRouter } from '../router';

const TOKEN = { 'x-service-auth': 'test-token-123' };
const AGENT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const THREAD_ID = '33333333-3333-3333-3333-333333333333';
const CONNECTOR_ID = '44444444-4444-4444-4444-444444444444';
const TURN_ID = '55555555-5555-5555-5555-555555555555';
const FILE_ID = '66666666-6666-6666-6666-666666666666';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/generated-files', generatedFilesRouter);
  return app;
}

async function post(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body })
        .then(async (res) => {
          const parsed = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: parsed as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const connectorNativeBody = {
  agentId: AGENT_ID,
  tenantId: TENANT_ID,
  baseName: 'Quarterly review',
  outputType: 'gdoc',
  conversationId: THREAD_ID,
  connectorId: CONNECTOR_ID,
  connectorFileId: 'doc-abc',
  webViewUrl: 'https://docs.google.com/document/d/doc-abc/edit',
};

function postConnectorNative(body: Record<string, unknown>) {
  return post(
    '/api/generated-files/register-connector-native',
    JSON.stringify(body),
    { 'content-type': 'application/json', ...TOKEN },
  );
}

function postUpload(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([Buffer.from('bytes')], { type: 'application/pdf' }), 'report.pdf');
  return post('/api/generated-files', form, TOKEN);
}

/** The positional appendMessage call, named. */
function appended() {
  expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  const call = mockAppendMessage.mock.calls[0];
  return {
    messageType: call[8] as string,
    attachment: (call[9] as Array<Record<string, unknown>>)[0],
    turnId: call[11] as string | null,
    producedInTurnId: call[13] as string | null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClientQuery.mockReset();
  mockAppendMessage.mockReset();
  mockStoreMediaObject.mockReset();
  mockWithTenantScope.mockImplementation(async (_tenantId, fn) => fn({ query: mockClientQuery }));
  // Connector-native: the version query, then the insert.
  mockClientQuery
    .mockResolvedValueOnce({ rows: [{ next_version: 1 }] })
    .mockResolvedValueOnce({ rows: [{ id: FILE_ID }] });
  mockStoreMediaObject.mockResolvedValue({
    id: FILE_ID,
    filename: 'report_v1.pdf',
    version: 1,
    gcsPath: 'tenants/x/agents/y/z/report_v1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5,
    signedUrl: 'https://storage.example/signed',
  });
});

describe('POST /register-connector-native', () => {
  it('accepts gdoc and names the file with no extension', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    const res = await postConnectorNative(connectorNativeBody);
    expect(res.status).toBe(201);
    expect(appended().attachment.filename).toBe('Quarterly review_v1');
  });

  it('answers cardAppended: true only when the file_output insert returned a row', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    const res = await postConnectorNative(connectorNativeBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: FILE_ID, cardAppended: true });
  });

  it('answers cardAppended: false, still 201, when the message insert throws', async () => {
    mockAppendMessage.mockRejectedValue(new Error('relation is being rewritten'));
    const res = await postConnectorNative(connectorNativeBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: FILE_ID, cardAppended: false });
  });

  it('answers cardAppended: false when there is no conversation to card into', async () => {
    const { conversationId: _omit, ...noThread } = connectorNativeBody;
    void _omit;
    const res = await postConnectorNative(noThread);
    expect(res.status).toBe(201);
    expect(res.body.cardAppended).toBe(false);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('writes downloadUrl: null on the attachment, never omits it', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    await postConnectorNative(connectorNativeBody);
    const { attachment, messageType } = appended();
    expect(messageType).toBe('file_output');
    expect('downloadUrl' in attachment).toBe(true);
    expect(attachment.downloadUrl).toBeNull();
    expect(attachment.webViewUrl).toBe(connectorNativeBody.webViewUrl);
  });

  it('stamps the card with the turn in produced_in_turn_id and leaves turn_id null', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    await postConnectorNative({ ...connectorNativeBody, turnId: TURN_ID });
    const { turnId, producedInTurnId } = appended();
    expect(producedInTurnId).toBe(TURN_ID);
    // Two cards in one turn must both insert: acm_assistant_turn_uniq is on
    // turn_id, so a card never carries it.
    expect(turnId).toBeNull();
  });

  it('writes a card with no turn when the caller sent none', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    await postConnectorNative(connectorNativeBody);
    expect(appended().producedInTurnId).toBeNull();
  });

  it('refuses a turnId that is not a uuid', async () => {
    const res = await postConnectorNative({ ...connectorNativeBody, turnId: 'turn-1' });
    expect(res.status).toBe(400);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});

describe('POST / (upload)', () => {
  const fields = {
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    baseName: 'report',
    outputType: 'pdf',
    conversationId: THREAD_ID,
  };

  it('answers cardAppended: true when the card row was inserted, with the turn stamped', async () => {
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
    const res = await postUpload({ ...fields, turnId: TURN_ID });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: FILE_ID, cardAppended: true });
    const { turnId, producedInTurnId, attachment } = appended();
    expect(producedInTurnId).toBe(TURN_ID);
    expect(turnId).toBeNull();
    expect(attachment.downloadUrl).toBe('https://storage.example/signed');
  });

  it('answers cardAppended: false, still 201, when the message insert throws', async () => {
    mockAppendMessage.mockRejectedValue(new Error('no such thread'));
    const res = await postUpload(fields);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: FILE_ID, cardAppended: false });
  });
});
