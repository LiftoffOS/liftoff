// Writing a file and showing it are separate acts.
//
// Until this existed, every card was appended in the same request that created
// the file, so bytes that arrived without a conversation — an autonomous run's
// output, or anything a custom API answered with — could never afterwards be
// put in front of a person. The tests below fix the two properties that makes
// true: a stored file can be shown later, into a conversation the CALLER names
// and never one carried by the file, and showing it is what makes it permanent.

const mockWithTenantScope = jest.fn();
const mockClientQuery = jest.fn();
const mockAgentChatAppend = jest.fn();
const mockLiftoffAppend = jest.fn();
const mockInsightsAppend = jest.fn();
const mockSignedUrl = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (
    tenantId: string,
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => mockWithTenantScope(tenantId, fn),
  withAdminScope: jest.fn(),
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../gcs-client', () => ({
  generatedFilesBucket: () => ({ file: () => ({ getSignedUrl: mockSignedUrl }) }),
}));
jest.mock('../../agent-chat/chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockAgentChatAppend(...a),
}));
jest.mock('../../liftoff/chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockLiftoffAppend(...a),
}));
jest.mock('../../insights/chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockInsightsAppend(...a),
}));
jest.mock('../../agent-audit-logs/service', () => ({
  agentAuditLogsService: { insertAuditLog: jest.fn().mockResolvedValue(undefined) },
}));

import { presentFile, PresentFileError } from '../present';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const FILE = '00000000-0000-0000-0000-0000000000f1';
const THREAD = '00000000-0000-0000-0000-0000000000c1';
const AGENT = '00000000-0000-0000-0000-0000000000e1';

/** One stored row, with whatever the test wants to vary. */
function storedRow(over: Record<string, unknown> = {}) {
  return {
    filename: 'invoice_v1.pdf',
    base_name: 'invoice',
    version: 1,
    output_type: 'pdf',
    gcs_path: 'tenants/t/agents/a/1/invoice_v1.pdf',
    web_view_url: null,
    mime_type: 'application/pdf',
    discard_after: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignedUrl.mockResolvedValue(['https://signed.example/invoice']);
  // withTenantScope hands the callback a client; the queries run in order.
  mockWithTenantScope.mockImplementation((_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockClientQuery }));
  mockClientQuery.mockResolvedValue({ rows: [storedRow()], rowCount: 1 });
  mockAgentChatAppend.mockResolvedValue({ id: 'msg-1' });
  mockLiftoffAppend.mockResolvedValue({ id: 'msg-1' });
  mockInsightsAppend.mockResolvedValue({ id: 'msg-1' });
});

describe('showing a file that already exists', () => {
  it('cards it into the conversation the caller named, not one carried by the file', async () => {
    const out = await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });

    expect(out).toEqual({ filename: 'invoice_v1.pdf', outputType: 'pdf', version: 1 });
    const [, threadId, role, content, agentId] = mockAgentChatAppend.mock.calls[0];
    expect(threadId).toBe(THREAD);
    expect(role).toBe('assistant');
    expect(content).toBe('');
    expect(agentId).toBe(AGENT);
  });

  it('stores no bytes and creates no second file', async () => {
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    // Presenting the same file twice must not turn one file into two, which is
    // what any re-store would do.
    const statements = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /INSERT INTO generated_files/i.test(s))).toBe(false);
  });

  it('carries the card as the type that makes it a card rather than speech', async () => {
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    expect(mockAgentChatAppend.mock.calls[0][8]).toBe('file_output');
    const [attachment] = mockAgentChatAppend.mock.calls[0][9] as Array<Record<string, unknown>>;
    expect(attachment).toMatchObject({
      generatedFileId: FILE, filename: 'invoice_v1.pdf', outputType: 'pdf', version: 1,
    });
  });

  it('stamps the turn in its own column and leaves turn_id null', async () => {
    const TURN = '00000000-0000-0000-0000-0000000000d1';
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT, turnId: TURN,
    });
    const call = mockAgentChatAppend.mock.calls[0];
    expect(call[11]).toBeNull();  // turn_id — the reply owns it
    expect(call[13]).toBe(TURN);  // produced_in_turn_id
  });
});

describe('publishing is what makes a file permanent', () => {
  it('clears the lifetime of a staged file', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [storedRow({ discard_after: new Date() })], rowCount: 1 });
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    const statements = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /SET discard_after = NULL/i.test(s))).toBe(true);
  });

  it('writes nothing when the file was never staged', async () => {
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    const statements = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /SET discard_after/i.test(s))).toBe(false);
  });

  it('leaves the lifetime alone when the card could not be written', async () => {
    // Otherwise a file whose card failed is kept forever with nothing pointing
    // at it: unreachable, undiscardable, and counted against the workspace.
    mockClientQuery.mockResolvedValueOnce({ rows: [storedRow({ discard_after: new Date() })], rowCount: 1 });
    mockAgentChatAppend.mockRejectedValueOnce(new Error('thread is gone'));

    await expect(presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    })).rejects.toThrow('thread is gone');

    const statements = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /SET discard_after/i.test(s))).toBe(false);
  });
});

describe('the download link', () => {
  it('is null for a file that lives in a connected service, never omitted', async () => {
    // The card hides its download button on `=== null` and offers to open the
    // file where it actually lives. An absent key would draw a broken button.
    mockClientQuery.mockResolvedValueOnce({
      rows: [storedRow({ gcs_path: null, web_view_url: 'https://drive.example/d/1' })],
      rowCount: 1,
    });
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    const [attachment] = mockAgentChatAppend.mock.calls[0][9] as Array<Record<string, unknown>>;
    expect(attachment).toHaveProperty('downloadUrl', null);
    expect(attachment.webViewUrl).toBe('https://drive.example/d/1');
  });

  it('still shows the file when signing fails, because the card re-mints its own', async () => {
    mockSignedUrl.mockRejectedValueOnce(new Error('IAM unavailable'));
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    expect(mockAgentChatAppend).toHaveBeenCalled();
    const [attachment] = mockAgentChatAppend.mock.calls[0][9] as Array<Record<string, unknown>>;
    expect(attachment.downloadUrl).toBeNull();
  });
});

describe('the surfaces', () => {
  it('writes a Liftoff card to its own files column, never to attachments', async () => {
    // On that table `attachments` means what the PERSON sent. ADR-051 settled
    // this for media; a produced file follows the same rule.
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'liftoff',
      conversationId: THREAD, agentId: null,
    });
    const arg = mockLiftoffAppend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.threadId).toBe(THREAD);
    expect(arg.messageType).toBe('file_output');
    expect(arg.files).toHaveLength(1);
    expect(arg.attachments).toBeUndefined();
  });

  it('writes an Insights card the same way', async () => {
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'insights',
      conversationId: THREAD, agentId: null,
    });
    const arg = mockInsightsAppend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.messageType).toBe('file_output');
    expect(arg.files).toHaveLength(1);
    expect(arg.attachments).toBeUndefined();
  });
});

describe('what it refuses', () => {
  it('reads a file from another workspace as absent, rather than confirming it exists', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    })).rejects.toThrow(PresentFileError);
    expect(mockAgentChatAppend).not.toHaveBeenCalled();
  });

  it('looks the file up inside the tenant scope, so RLS is what hides it', async () => {
    await presentFile({
      tenantId: TENANT, fileId: FILE, surface: 'agent_chat',
      conversationId: THREAD, agentId: AGENT,
    });
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT);
  });
});
