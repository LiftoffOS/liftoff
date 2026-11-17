// A document the team generates ITSELF registers as a card, through the
// upload route — the same boundary as the connector-native one.
//
// `dualWrite` is the funnel generate_xlsx / generate_docx / generate_pptx
// share: bytes to the platform's upload route, bytes to the connector, and a
// back-reference between the two. The upload route's `generated_files.agent_id`
// is the same foreign key to platform-backend's `internal_agents.id`, so the
// form has to carry the translated id and never the runtime id the handler
// context holds (ADR-039), plus the turn the call ran in. The connector upload
// is not conditional on the platform's bookkeeping: with no mapping, or a
// refusal, the file the person asked for still lands in their storage.

import type { ConnectorManifest } from '@liftoffos/connector-types';

const logError = jest.fn();
const resolveInternalAgentId = jest.fn();

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => logError(...a), debug: jest.fn() },
}));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'token' }));
jest.mock('@liftoffos/service-client', () => ({ buildOidcAuthHeader: jest.fn().mockResolvedValue({}) }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => resolveInternalAgentId(...a),
}));

import { generateXlsx } from '../document-tool-handlers';

const manifest = { id: '44444444-4444-4444-4444-444444444444', connectorType: 'google_drive', alias: 'google-drive', displayName: 'Google Drive' } as unknown as ConnectorManifest;
const ctx = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  agentId: 'runtime-agent-uuid',
  threadId: '33333333-3333-3333-3333-333333333333',
  turnId: '55555555-5555-5555-5555-555555555555',
  memoryScope: {},
};
const args = { baseName: 'pipeline', sheets: [{ name: 'Q3', columns: ['Deal', 'Stage'], rows: [['Acme', 'Won']] }] };

type Call = { url: string; method: string; form: FormData | null };
let calls: Call[];
const originalFetch = global.fetch;

function stubFetch(platform: { status: number; body: unknown }) {
  calls = [];
  global.fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ url, method: init?.method ?? 'GET', form });
    if (url.endsWith('/api/generated-files') && init?.method === 'POST') {
      return {
        ok: platform.status >= 200 && platform.status < 300,
        status: platform.status,
        json: async () => platform.body,
        text: async () => JSON.stringify(platform.body),
      } as unknown as Response;
    }
    if (url.includes('/files?tenantId=') || /\/files$/.test(url.split('?')[0])) {
      return { ok: true, status: 201, json: async () => ({ fileId: 'drive-1', path: '/pipeline.xlsx', webViewUrl: 'https://drive.google.com/file/d/drive-1/view' }) } as unknown as Response;
    }
    if (/\/api\/generated-files\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  }) as unknown as typeof fetch;
}

const upload = () => calls.find((c) => c.url.endsWith('/api/generated-files') && c.method === 'POST');
const connectorUpload = () => calls.find((c) => c.url.includes('/files') && c.method === 'POST' && !c.url.includes('generated-files'));

beforeEach(() => {
  process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
  process.env.CONNECTOR_SERVICE_URL = 'https://cs.test';
  logError.mockReset();
  resolveInternalAgentId.mockReset().mockResolvedValue('11111111-1111-1111-1111-111111111111');
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('dualWrite, through generateXlsx', () => {
  it('sends the INTERNAL agent id and the turn on the upload form, never the runtime id', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', downloadUrl: 'https://storage/signed', version: 1, cardAppended: true } });
    await generateXlsx(args, manifest, ctx);
    expect(resolveInternalAgentId).toHaveBeenCalledWith(ctx.tenantId, 'runtime-agent-uuid', 'document-tools');
    const form = upload()!.form!;
    expect(form.get('agentId')).toBe('11111111-1111-1111-1111-111111111111');
    expect(form.get('agentId')).not.toBe('runtime-agent-uuid');
    expect(form.get('tenantId')).toBe(ctx.tenantId);
    expect(form.get('conversationId')).toBe(ctx.threadId);
    expect(form.get('turnId')).toBe(ctx.turnId);
    expect(form.get('outputType')).toBe('xlsx');
  });

  it('carries the platform\'s answer: the host note only on cardAppended: true', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', downloadUrl: 'https://storage/signed', version: 1, cardAppended: true } });
    const result = await generateXlsx(args, manifest, ctx);
    expect(result).toMatchObject({
      generatedFileId: 'gf-1',
      version: 1,
      downloadUrl: 'https://storage/signed',
      cardAppended: true,
      hostNote: 'Attached to this conversation as a file card: pipeline.xlsx.',
    });
  });

  it('carries no host note on a file id alone', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', downloadUrl: 'https://storage/signed', version: 1, cardAppended: false } });
    const result = await generateXlsx(args, manifest, ctx);
    expect(result).toMatchObject({ generatedFileId: 'gf-1', cardAppended: false });
    expect('hostNote' in result).toBe(false);
  });

  it('skips the platform, never sends the runtime id, and still uploads to the connector when the id has no mapping', async () => {
    resolveInternalAgentId.mockResolvedValue(null);
    stubFetch({ status: 201, body: { id: 'gf-1' } });
    const result = await generateXlsx(args, manifest, ctx);
    expect(upload()).toBeUndefined();
    expect(connectorUpload()).toBeDefined();
    expect(result).toMatchObject({ filename: 'pipeline.xlsx', webViewUrl: 'https://drive.google.com/file/d/drive-1/view' });
    expect((result as { generatedFileId?: string }).generatedFileId).toBeUndefined();
    expect(result).not.toHaveProperty('cardAppended');
  });

  it.each([400, 500])('on a %s from the upload route: status + body at error with the event, and the connector upload still happens', async (status) => {
    stubFetch({ status, body: { error: 'Validation failed' } });
    const result = await generateXlsx(args, manifest, ctx);
    expect(connectorUpload()).toBeDefined();
    expect(result).toMatchObject({ filename: 'pipeline.xlsx', webViewUrl: 'https://drive.google.com/file/d/drive-1/view' });
    expect((result as { generatedFileId?: string }).generatedFileId).toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'generated_file_registration_failed',
        status,
        body: expect.stringContaining('Validation failed'),
        tenantId: ctx.tenantId,
        outputType: 'xlsx',
      }),
      expect.any(String),
    );
  });
});
