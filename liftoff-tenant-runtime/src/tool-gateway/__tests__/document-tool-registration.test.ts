// A deck or doc the team writes INTO the connector registers as a card.
//
// Every connector-native site in document-tool-handlers.ts funnels through
// one function, and that function crosses into platform-backend's database:
// `generated_files.agent_id` is a foreign key to `internal_agents.id`, and the
// handler context holds the RUNTIME id (ADR-039). The body has to carry the
// translated id, the turn the call ran in, and an output type the platform's
// enum holds — a wrong-space id is a 500, an unknown type is a 400, and the
// handler's fallback turns both into a success-shaped result with no card.
//
// What comes back matters as much as what goes out: `cardAppended` is read
// from the platform's answer, never inferred from a 201, and the host note
// the model may repeat exists only on `cardAppended: true`.

import * as fs from 'fs';
import * as path from 'path';
import type { ConnectorManifest } from '@liftoffos/connector-types';

const logError = jest.fn();
const logWarn = jest.fn();
const resolveInternalAgentId = jest.fn();

jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => logWarn(...a),
    error: (...a: unknown[]) => logError(...a),
    debug: jest.fn(),
  },
}));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'token' }));
jest.mock('@liftoffos/service-client', () => ({ buildOidcAuthHeader: jest.fn().mockResolvedValue({}) }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => resolveInternalAgentId(...a),
}));

import { generatePresentationSlides, generateGoogleDoc } from '../document-tool-handlers';
import { hostsGoogleNativeDocs, hostsGoogleNativeSlides } from '../google-native-hosts';

/** The platform's document output types — `outputTypeSchema.exclude(['media'])`
 *  in platform-backend's generated-files/store.ts, with `gdoc` as of its
 *  migration 473. Neither repo can see the other's constant, so the seven
 *  sites' literals are pinned against this copy here. */
const PLATFORM_DOCUMENT_OUTPUT_TYPES = ['xlsx', 'docx', 'docx_redlined', 'pptx', 'gslides', 'gdoc', 'pdf', 'binary'];

describe('every outputType a connector-native site can send', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'document-tool-handlers.ts'), 'utf8');

  it('is a value the platform enum holds, and names a Google-native file as Google-native', () => {
    // Every `registerConnectorNative({ ... outputType: '<literal>' ... })` call.
    const calls = [...source.matchAll(/registerConnectorNative\(\{[\s\S]*?outputType:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    for (const outputType of calls) {
      expect(PLATFORM_DOCUMENT_OUTPUT_TYPES).toContain(outputType);
    }
    // Exactly the seven sites: four decks and three Google Docs. Every file
    // this door registers lives in Google, and a Google Doc registered as
    // `docx` would card as `Report_v1.docx` beside a URL that opens a Google
    // Doc — so no site sends docx.
    expect([...calls].sort()).toEqual(['gdoc', 'gdoc', 'gdoc', 'gslides', 'gslides', 'gslides', 'gslides']);
  });
});

describe('registerConnectorNative, through generatePresentationSlides', () => {
  const manifest = { id: '44444444-4444-4444-4444-444444444444', connectorType: 'google_slides', alias: 'google-slides', displayName: 'Google Slides' } as unknown as ConnectorManifest;
  const ctx = {
    tenantId: '22222222-2222-2222-2222-222222222222',
    agentId: 'runtime-agent-uuid',
    threadId: '33333333-3333-3333-3333-333333333333',
    turnId: '55555555-5555-5555-5555-555555555555',
    memoryScope: {},
  };
  const args = { title: 'Board deck', slides: [{ title: 'One' }] };
  const created = { presentationId: 'pres-1', name: 'Board deck', webViewUrl: 'https://docs.google.com/presentation/d/pres-1/edit' };

  type Call = { url: string; body: Record<string, unknown> | null };
  let calls: Call[];
  const originalFetch = global.fetch;

  /** The connector answers the create synchronously (201); the platform
   *  answers the registration as the test says. */
  function stubFetch(platform: { status: number; body: unknown }) {
    calls = [];
    global.fetch = (async (url: string, init?: { body?: string }) => {
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url.includes('/presentations/create-from-template')) {
        return { ok: true, status: 201, json: async () => created } as unknown as Response;
      }
      if (url.includes('/api/generated-files/register-connector-native')) {
        return {
          ok: platform.status >= 200 && platform.status < 300,
          status: platform.status,
          json: async () => platform.body,
          text: async () => JSON.stringify(platform.body),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
  }

  const registration = () => calls.find((c) => c.url.includes('register-connector-native'));

  beforeEach(() => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    process.env.CONNECTOR_SERVICE_URL = 'https://cs.test';
    logError.mockReset();
    logWarn.mockReset();
    resolveInternalAgentId.mockReset().mockResolvedValue('11111111-1111-1111-1111-111111111111');
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('sends the INTERNAL agent id and the turn from the context, never the runtime id', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', cardAppended: true } });
    await generatePresentationSlides(args, manifest, ctx);
    expect(resolveInternalAgentId).toHaveBeenCalledWith(ctx.tenantId, 'runtime-agent-uuid', 'document-tools');
    const body = registration()!.body!;
    expect(body.agentId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.agentId).not.toBe('runtime-agent-uuid');
    expect(body).toMatchObject({
      tenantId: ctx.tenantId,
      conversationId: ctx.threadId,
      turnId: ctx.turnId,
      outputType: 'gslides',
      connectorId: manifest.id,
      connectorFileId: 'pres-1',
      webViewUrl: created.webViewUrl,
    });
  });

  it('takes the no-card fallback and sends nothing when the runtime id has no mapping', async () => {
    resolveInternalAgentId.mockResolvedValue(null);
    stubFetch({ status: 201, body: { id: 'gf-1', cardAppended: true } });
    const result = await generatePresentationSlides(args, manifest, ctx);
    expect(registration()).toBeUndefined();
    expect(result).toEqual({ filename: 'Board deck', webViewUrl: created.webViewUrl });
  });

  it('carries the host note only when the platform answered cardAppended: true', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', cardAppended: true } });
    const result = await generatePresentationSlides(args, manifest, ctx);
    expect(result).toMatchObject({
      generatedFileId: 'gf-1',
      cardAppended: true,
      hostNote: 'Attached to this conversation as a file card: Board deck.',
    });
  });

  it('carries no host note on a file id alone', async () => {
    stubFetch({ status: 201, body: { id: 'gf-1', cardAppended: false } });
    const result = await generatePresentationSlides(args, manifest, ctx);
    expect(result).toMatchObject({ generatedFileId: 'gf-1', cardAppended: false });
    expect('hostNote' in result).toBe(false);
  });

  it.each([400, 500])('on a %s: the fallback, and status + body at error with the event', async (status) => {
    stubFetch({ status, body: { error: 'Validation failed' } });
    const result = await generatePresentationSlides(args, manifest, ctx);
    // The write that created the deck already succeeded; the fallback is the
    // link the person got before cards existed, and it does not claim a card.
    expect(result).toEqual({ filename: 'Board deck', webViewUrl: created.webViewUrl });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'connector_native_registration_failed',
        status,
        body: expect.stringContaining('Validation failed'),
        tenantId: ctx.tenantId,
        outputType: 'gslides',
      }),
      expect.any(String),
    );
  });
});

describe('which door a Drive-bound team reaches for a deck or a document', () => {
  // `generate_pptx` and `generate_docx` are one tool name each, dispatching
  // to the native Google handler or the bytes handler. The dispatch keyed on
  // the connector's TYPE, so a team bound to google_drive — which hosts native
  // Docs and Slides — always got a .pptx pushed into Drive as a foreign file,
  // and on a composio_managed Drive could not even complete that (binary does
  // not cross the proxy). The read side made the same fix in August ("pick
  // the presentation reader by file type, not connector type"); the write
  // side had kept the defect. Pinned per connector type, both ways.

  it('sends google_drive, google_slides and google_docs to the native door', () => {
    expect(hostsGoogleNativeSlides('google_drive')).toBe(true);
    expect(hostsGoogleNativeSlides('google_slides')).toBe(true);
    expect(hostsGoogleNativeDocs('google_drive')).toBe(true);
    expect(hostsGoogleNativeDocs('google_docs')).toBe(true);
  });

  it('keeps every other cloud store on the bytes door', () => {
    for (const type of ['microsoft_onedrive', 'microsoft_sharepoint', 'dropbox', 'box']) {
      expect({ type, slides: hostsGoogleNativeSlides(type), docs: hostsGoogleNativeDocs(type) })
        .toEqual({ type, slides: false, docs: false });
    }
  });

  it('a Slides host is not a Docs host and vice versa', () => {
    expect(hostsGoogleNativeDocs('google_slides')).toBe(false);
    expect(hostsGoogleNativeSlides('google_docs')).toBe(false);
  });
});

describe('the folder a native file is asked into reaches the connector', () => {
  // The tool schema promises "Google Drive and Slides take the folder ID";
  // the native handlers dropped outputPath and every deck and doc landed in
  // My Drive root. The wire name is parentFolderId — a PATH means nothing to
  // the Slides or Docs APIs, and the connector applies it as one move.
  const manifest = { id: '44444444-4444-4444-4444-444444444444', connectorType: 'google_drive', alias: 'google-drive', displayName: 'Google Drive' } as unknown as ConnectorManifest;
  const ctx = { tenantId: '22222222-2222-2222-2222-222222222222', agentId: 'runtime-agent-uuid', memoryScope: {} };
  const originalFetch = global.fetch;
  let bodies: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    bodies = [];
    global.fetch = (async (url: string, init?: { body?: string }) => {
      if (typeof init?.body === 'string') bodies.push({ url, body: JSON.parse(init.body) });
      if (url.includes('/presentations/create-from-template')) {
        return { ok: true, status: 201, json: async () => ({ presentationId: 'p', name: 'x', webViewUrl: 'https://docs.google.com/presentation/d/p/edit' }) } as unknown as Response;
      }
      if (url.includes('/documents/create')) {
        return { ok: true, status: 201, json: async () => ({ documentId: 'd', name: 'x', webViewUrl: 'https://docs.google.com/document/d/d/edit' }) } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('sends outputPath as parentFolderId on a native deck', async () => {
    await generatePresentationSlides({ title: 'Deck', slides: [{ title: 'One' }], outputPath: 'folder-7' } as never, manifest, ctx as never);
    const create = bodies.find((b) => b.url.includes('create-from-template'));
    expect(create?.body).toMatchObject({ parentFolderId: 'folder-7', name: 'Deck' });
  });

  it('sends outputPath as parentFolderId on a native document', async () => {
    await generateGoogleDoc({ title: 'Memo', sections: [{ content: 'hi' }], outputPath: 'folder-7' } as never, manifest, ctx as never);
    const create = bodies.find((b) => b.url.includes('/documents/create'));
    expect(create?.body).toMatchObject({ parentFolderId: 'folder-7', title: 'Memo' });
  });
});
