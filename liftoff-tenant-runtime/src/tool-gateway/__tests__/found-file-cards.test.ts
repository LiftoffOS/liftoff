// A file the team found becomes a card — and only when it should.
//
// The three narrowings are the test: a listing does not card, an autonomous
// run does not card, and a response without the file's own identity does not
// card. Each one is a way a card would have been noise or wrong, and each is
// asserted as an absence, because "no card" reads as "works" if nothing pins
// that it was refused rather than dropped.

import { cardFoundFile, foundFileFrom, hostNoteForCardedFile, outputTypeForMime } from '../found-file-cards';

const logError = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => logError(...a), debug: jest.fn() },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  catalogTypeFor: (c: string) => c.replace(/-/g, '_').replace(/_[0-9a-f]{8}$/, ''),
}));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'token' }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({ resolveInternalAgentId: jest.fn().mockResolvedValue('internal-1') }));

const driveDownload = {
  success: true,
  data: {
    id: '11oLOzMC4S614mxUUAvLEfV7Myx6whVBh',
    kind: 'drive#file',
    name: 'Larkspur-Tern NDA (3 Mar 2026).pdf',
    mimeType: 'application/pdf',
    downloaded_file_content: { name: 'x', s3url: '[delivered to the surface]', mimetype: 'application/pdf' },
  },
};

describe('foundFileFrom', () => {
  it('reads a Drive download as the file it handed over, with a view URL built from the id', () => {
    const f = foundFileFrom({ connector: 'google-drive-6ceb3f30', actionType: 'download_file', result: driveDownload });
    expect(f).toEqual({
      connectorFileId: '11oLOzMC4S614mxUUAvLEfV7Myx6whVBh',
      name: 'Larkspur-Tern NDA (3 Mar 2026).pdf',
      outputType: 'pdf',
      webViewUrl: 'https://drive.google.com/file/d/11oLOzMC4S614mxUUAvLEfV7Myx6whVBh/view',
    });
  });

  it('prefers the response\'s own webViewLink when it carries one', () => {
    const f = foundFileFrom({
      connector: 'google_drive',
      actionType: 'get_file_metadata',
      result: { data: { id: 'abc', name: 'Deck', mimeType: 'application/vnd.google-apps.presentation', webViewLink: 'https://docs.google.com/presentation/d/abc/edit' } },
    });
    expect(f?.outputType).toBe('gslides');
    expect(f?.webViewUrl).toBe('https://docs.google.com/presentation/d/abc/edit');
  });

  it('does NOT card a listing — a search result is not a hand-off', () => {
    expect(foundFileFrom({
      connector: 'google_drive',
      actionType: 'find_file',
      result: { data: { files: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
    })).toBeNull();
  });

  it('does NOT card a connector whose response shape has not been read', () => {
    expect(foundFileFrom({ connector: 'dropbox', actionType: 'download_file', result: driveDownload })).toBeNull();
  });

  it('does NOT card a response missing the file\'s own name — a card with no name is worse than a link', () => {
    expect(foundFileFrom({ connector: 'google_drive', actionType: 'download_file', result: { data: { id: 'abc' } } })).toBeNull();
  });
});

/** The registration route's schema is `outputTypeSchema.exclude(['media'])`
 *  in platform-backend's generated-files/store.ts. A value outside it is a
 *  silent 400 and a card that never appears, so every value this module can
 *  emit is pinned against that list here — the one place both sides meet.
 *  `gdoc` joined the platform enum with its migration 473. */
const PLATFORM_DOCUMENT_OUTPUT_TYPES = ['xlsx', 'docx', 'docx_redlined', 'pptx', 'gslides', 'gdoc', 'pdf', 'binary'];

describe('outputTypeForMime', () => {
  it('only ever emits a type the registration route accepts', () => {
    for (const mime of [
      'application/vnd.google-apps.document', 'application/vnd.google-apps.presentation',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf', 'image/png', 'text/csv', undefined,
    ]) {
      expect(PLATFORM_DOCUMENT_OUTPUT_TYPES).toContain(outputTypeForMime(mime));
    }
  });

  it('names what the platform can name and falls back to binary, never to a guess', () => {
    // A native Google Doc is gdoc, not docx: the platform names a card
    // `${baseName}_v${n}.${ext}`, and docx would put `.docx` on a file that
    // opens as a Google Doc.
    expect(outputTypeForMime('application/vnd.google-apps.document')).toBe('gdoc');
    expect(outputTypeForMime('application/vnd.google-apps.presentation')).toBe('gslides');
    expect(outputTypeForMime('APPLICATION/PDF')).toBe('pdf');
    expect(outputTypeForMime('image/png')).toBe('binary');
    expect(outputTypeForMime(undefined)).toBe('binary');
  });
});

describe('cardFoundFile', () => {
  const base = {
    tenantId: 't1',
    agentId: 'a1',
    connector: 'google-drive-6ceb3f30',
    connectorId: 'conn-1',
    actionType: 'download_file',
    result: driveDownload,
  };

  it('registers the found file for the interactive turn, connector-natively, with the turn it ran in', async () => {
    const register = jest.fn().mockResolvedValue({ cardAppended: true });
    const carded = cardFoundFile({ ...base, threadId: 'thread-1', turnId: 'turn-1', register });
    expect(carded?.file.name).toBe('Larkspur-Tern NDA (3 Mar 2026).pdf');
    await Promise.resolve();
    expect(register).toHaveBeenCalledWith({
      tenantId: 't1',
      agentId: 'a1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      connectorId: 'conn-1',
      file: expect.objectContaining({ connectorFileId: '11oLOzMC4S614mxUUAvLEfV7Myx6whVBh', outputType: 'pdf' }),
    });
  });

  it('does NOT card an autonomous run — no thread, no chat to card into', () => {
    const register = jest.fn();
    expect(cardFoundFile({ ...base, threadId: undefined, turnId: undefined, register })).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('does NOT card a call with no resolved binding', () => {
    const register = jest.fn();
    expect(cardFoundFile({ ...base, threadId: 'thread-1', turnId: 'turn-1', connectorId: undefined, register })).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('never fails the read when registration fails — the reply keeps its link', async () => {
    const register = jest.fn().mockRejectedValue(new Error('503'));
    let carded: ReturnType<typeof cardFoundFile> = null;
    expect(() => { carded = cardFoundFile({ ...base, threadId: 'thread-1', turnId: 'turn-1', register }); }).not.toThrow();
    await expect(carded!.cardAppended).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('reads cardAppended from the transport, and a false is a false', async () => {
    const register = jest.fn().mockResolvedValue({ cardAppended: false });
    const carded = cardFoundFile({ ...base, threadId: 'thread-1', turnId: 'turn-1', register });
    await expect(carded!.cardAppended).resolves.toBe(false);
  });
});

describe('hostNoteForCardedFile', () => {
  // The model is told about the card by the host, and only on the platform's
  // word that the card exists. A file id, a timeout and a failure all say
  // nothing, because on each of those the card may not be there.
  const file = { connectorFileId: 'f1', name: 'Grid.pdf', outputType: 'pdf', webViewUrl: 'https://drive.google.com/file/d/f1/view' };

  it('appends the note only when the registration answered cardAppended: true', async () => {
    await expect(hostNoteForCardedFile({ file, cardAppended: Promise.resolve(true) }))
      .resolves.toBe('Attached to this conversation as a file card: Grid.pdf.');
  });

  it('appends nothing on cardAppended: false', async () => {
    await expect(hostNoteForCardedFile({ file, cardAppended: Promise.resolve(false) })).resolves.toBeUndefined();
  });

  it('appends nothing when the platform has not answered within the bound', async () => {
    const never = new Promise<boolean>(() => {});
    await expect(hostNoteForCardedFile({ file, cardAppended: never }, 20)).resolves.toBeUndefined();
  });

  it('appends nothing when nothing was carded', async () => {
    await expect(hostNoteForCardedFile(null)).resolves.toBeUndefined();
  });
});

describe('registerFoundFileWithPlatform', () => {
  // generated_files.agent_id is a foreign key to platform-backend's
  // internal_agents.id, and the gateway holds the runtime id — two spaces
  // (ADR-039). Passing the runtime id answers 500 on exactly this.
  const file = { connectorFileId: 'f1', name: 'Grid', outputType: 'pdf', webViewUrl: 'https://drive.google.com/file/d/f1/view' };

  async function withPlatform(
    answer: { status: number; body: unknown },
    run: (_calls: Array<{ url: string; body: Record<string, unknown> }>) => Promise<void>,
  ): Promise<void> {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
        text: async () => JSON.stringify(answer.body),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    try {
      await run(calls);
    } finally {
      global.fetch = originalFetch;
    }
  }

  beforeEach(() => logError.mockReset());

  it('sends the INTERNAL agent id, never the runtime id the gateway holds, and the turn it ran in', async () => {
    const { registerFoundFileWithPlatform } = await import('../found-file-cards');
    await withPlatform({ status: 201, body: { id: 'gf-1', cardAppended: true } }, async (calls) => {
      const registration = await registerFoundFileWithPlatform({
        tenantId: 't1', agentId: 'runtime-agent-uuid', threadId: 'thread-1', turnId: 'turn-1', connectorId: 'conn-1', file,
      });
      expect(registration).toEqual({ cardAppended: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://pb.test/api/generated-files/register-connector-native');
      expect(calls[0].body.agentId).toBe('internal-1');
      expect(calls[0].body.agentId).not.toBe('runtime-agent-uuid');
      expect(calls[0].body).toMatchObject({ tenantId: 't1', conversationId: 'thread-1', turnId: 'turn-1', connectorId: 'conn-1', connectorFileId: 'f1', baseName: 'Grid', outputType: 'pdf' });
    });
  });

  it('omits turnId from the body when the call carried none, rather than sending an empty one', async () => {
    const { registerFoundFileWithPlatform } = await import('../found-file-cards');
    await withPlatform({ status: 201, body: { id: 'gf-1', cardAppended: false } }, async (calls) => {
      await registerFoundFileWithPlatform({ tenantId: 't1', agentId: 'a', threadId: 'thread-1', turnId: undefined, connectorId: 'conn-1', file });
      expect('turnId' in calls[0].body).toBe(false);
    });
  });

  it('reads cardAppended from the answer and does not invent it from a 201', async () => {
    const { registerFoundFileWithPlatform } = await import('../found-file-cards');
    await withPlatform({ status: 201, body: { id: 'gf-1' } }, async () => {
      const registration = await registerFoundFileWithPlatform({ tenantId: 't1', agentId: 'a', threadId: 'thread-1', turnId: 'turn-1', connectorId: 'conn-1', file });
      expect(registration).toEqual({ cardAppended: false });
    });
  });

  it.each([400, 500])('logs status and body at error, with the event, on a %s — and the card is not claimed', async (status) => {
    const { registerFoundFileWithPlatform } = await import('../found-file-cards');
    await withPlatform({ status, body: { error: 'refused' } }, async () => {
      await expect(registerFoundFileWithPlatform({ tenantId: 't1', agentId: 'a', threadId: 'thread-1', turnId: 'turn-1', connectorId: 'conn-1', file }))
        .rejects.toThrow(`register-connector-native answered ${status}`);
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connector_native_registration_failed', status, body: expect.stringContaining('refused'), tenantId: 't1' }),
      expect.any(String),
    );
  });
});
