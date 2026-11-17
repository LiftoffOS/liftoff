// No engine drops a picture in silence — and the engines that CAN take one, do.
//
// Eight engine ids resolve to six adapter classes. Seven carry a real image
// block; one (ADK) owns its own loop and takes a text prompt, so it cannot, and
// describes the picture instead. Both outcomes are acceptable. The third one is
// not: a model that is handed a turn with no mention of the picture will answer
// about it from the file name, and nothing in that answer tells the person it
// never looked.
//
// This test exists because the failure is invisible everywhere else. A dropped
// image raises no error, fails no schema, and produces a fluent answer. It used
// to prove only the describing path, for all three self-managing engines. Codex
// and opencode carry now, so for those two it proves the picture reaches the
// engine's INPUT — the file Codex is pointed at, the part opencode is sent —
// rather than that a sentence about it does.

import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';

// ── Codex: the SDK is mocked at the loader; the thread records what it was run with.
const codexRuns: unknown[] = [];
// ── opencode: the client records the prompt body it was sent.
const opencodePrompts: unknown[] = [];
let codexImageDir: string | null = null;

jest.mock('../opencode/server', () => {
  const startOpencode = async () => ({
    client: {
      session: {
        create: async () => ({ data: { id: 's1' } }),
        prompt: async (body: unknown) => { opencodePrompts.push(body); return { data: { info: {}, parts: [] } }; },
        abort: async () => ({}),
        status: async () => ({ data: { s1: { type: 'idle' } } }),
        messages: async () => ({ data: [] }),
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield { type: 'session.idle', properties: { sessionID: 's1' } };
          })(),
        }),
      },
      tool: { ids: async () => ({ data: [] }) },
      postSessionIdPermissionsPermissionId: async () => ({}),
    },
    server: { url: 'http://127.0.0.1:1', close: () => undefined },
  });
  return { startOpencode };
});
jest.mock('../esm-import', () => {
  class Codex {
    constructor(public _opts: unknown) {}
    startThread() {
      return {
        id: 'thread-1',
        runStreamed: async (input: unknown) => {
          codexRuns.push(input);
          // Read while the turn is live: the file exists here and must not after.
          if (Array.isArray(input)) {
            const img = input.find((p: { type: string }) => p.type === 'local_image') as { path: string } | undefined;
            if (img) codexImageDir = dirname(img.path);
          }
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thread-1' };
              yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
            })(),
          };
        },
      };
    }
    resumeThread() { return this.startThread(); }
  }
  return { esmImport: async () => ({ Codex }) };
});
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: async () => ({ url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: async () => undefined }),
}));
jest.mock('../mcp-client-pool', () => ({ getMcpClientPool: () => ({ releaseAll: async () => undefined }) }));
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: async () => 'test-openrouter-key',
  getXaiApiKey: async () => 'test-xai-key',
}));
jest.mock('../../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'test-openai-key' }));

import { CodexAdapter } from '../codex';
import { OpencodeAdapter } from '../opencode';
import { attachedImages, firstTurnPrompt } from '../conversation-preamble';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationEvent, InvocationInput, PlatformMessage } from '../types';

// A 1x1 PNG, so the bytes on disk are a picture and not a placeholder.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const withImage: PlatformMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'media', mimeType: 'image/png', dataBase64: PNG_BASE64, alt: 'a bar chart' },
      { type: 'text', text: 'what does this show?' },
    ],
  },
];

const withVideo: PlatformMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'media', mimeType: 'video/mp4', dataBase64: 'AAAA' },
      { type: 'text', text: 'what happens at the end?' },
    ],
  },
];

/** A picture on an earlier turn AND on the current one. Both are unseen by a
 *  fresh session, so both are attached, in order. */
const withHistoryImage: PlatformMessage[] = [
  { role: 'user', content: [{ type: 'media', mimeType: 'image/jpeg', dataBase64: PNG_BASE64 }] },
  { role: 'assistant', content: [{ type: 'text', text: 'It is a chart.' }] },
  {
    role: 'user',
    content: [
      { type: 'media', mimeType: 'image/png', dataBase64: PNG_BASE64 },
      { type: 'text', text: 'and the trend?' },
    ],
  },
];

function catalog(): McpToolCatalog {
  return { servers: [], tools: [] };
}
function input(messages: PlatformMessage[], provider: InvocationInput['provider'], model: string): InvocationInput {
  return { messages, systemPrompt: 'sys', model, provider, tenantId: 't1', invocationId: 'inv-img', agentId: 'a1' };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => { codexRuns.length = 0; opencodePrompts.length = 0; codexImageDir = null; });

describe('Codex carries the picture as a local file on the turn', () => {
  it('attaches the image as local_image and names it in the text', async () => {
    const a = new CodexAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withImage, 'openai', 'gpt-5.3-codex'), new AbortController().signal));

    const first = codexRuns[0] as Array<{ type: string; text?: string; path?: string }>;
    expect(Array.isArray(first)).toBe(true);
    const text = first.find((p) => p.type === 'text')!;
    const image = first.find((p) => p.type === 'local_image')!;
    expect(text.text).toContain('what does this show?');
    expect(text.text).toContain('attachment 1');
    expect(text.text).toContain('a bar chart');
    expect(text.text).not.toContain('cannot see it');
    expect(image.path).toMatch(/attachment-1\.png$/);
  });

  it('writes the picture\'s own bytes to that file, and removes it when the run ends', async () => {
    let bytesWhileLive: Buffer | null = null;
    const a = new CodexAdapter();
    a.registerToolCatalog(catalog());
    // Read the file during the turn, through the mocked thread: by the time
    // invoke() returns, the directory is gone.
    const orig = codexRuns.push.bind(codexRuns);
    codexRuns.push = (...items: unknown[]) => {
      const img = Array.isArray(items[0])
        ? (items[0] as Array<{ type: string; path?: string }>).find((p) => p.type === 'local_image')
        : undefined;
      if (img?.path) bytesWhileLive = readFileSync(img.path);
      return orig(...items);
    };
    try {
      await drain(a.invoke(input(withImage, 'openai', 'gpt-5.3-codex'), new AbortController().signal));
    } finally {
      codexRuns.push = orig;
    }

    expect(bytesWhileLive).not.toBeNull();
    expect(bytesWhileLive!.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    expect(codexImageDir).not.toBeNull();
    expect(existsSync(codexImageDir!)).toBe(false);
  });

  it('attaches every picture in the conversation, numbered in order', async () => {
    const a = new CodexAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withHistoryImage, 'openai', 'gpt-5.3-codex'), new AbortController().signal));

    const first = codexRuns[0] as Array<{ type: string; text?: string; path?: string }>;
    const paths = first.filter((p) => p.type === 'local_image').map((p) => p.path!);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/attachment-1\.jpeg$/);
    expect(paths[1]).toMatch(/attachment-2\.png$/);
    const text = first.find((p) => p.type === 'text')!.text!;
    expect(text).toContain('Conversation so far');
    expect(text).toContain('attachment 1');
    expect(text).toContain('attachment 2');
    expect(text).toContain('and the trend?');
  });

  it('sends a plain string when there is nothing to attach', async () => {
    const a = new CodexAdapter();
    a.registerToolCatalog(catalog());
    const plain: PlatformMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    await drain(a.invoke(input(plain, 'openai', 'gpt-5.3-codex'), new AbortController().signal));
    expect(typeof codexRuns[0]).toBe('string');
  });

  it('still describes a video, which it has no input form for', async () => {
    const a = new CodexAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withVideo, 'openai', 'gpt-5.3-codex'), new AbortController().signal));
    const text = codexRuns[0] as string;
    expect(typeof text).toBe('string');
    expect(text).toContain('cannot watch it');
    expect(text).toContain('video/mp4');
    expect(text).toContain('what happens at the end?');
  });
});

describe('opencode carries the picture as a file part on the turn', () => {
  it('sends the image as a file part with a data URL and names it in the text', async () => {
    const a = new OpencodeAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withImage, 'glm', 'z-ai/glm-5.2'), new AbortController().signal));

    const body = (opencodePrompts[0] as { body: { parts: Array<Record<string, unknown>> } }).body;
    const text = body.parts.find((p) => p.type === 'text') as { text: string };
    const file = body.parts.find((p) => p.type === 'file') as { mime: string; url: string; filename: string };
    expect(text.text).toContain('what does this show?');
    expect(text.text).toContain('attachment 1');
    expect(text.text).not.toContain('cannot see it');
    expect(file.mime).toBe('image/png');
    expect(file.url).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(file.filename).toBe('attachment-1.png');
  });

  it('attaches every picture in the conversation, numbered in order', async () => {
    const a = new OpencodeAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withHistoryImage, 'glm', 'z-ai/glm-5.2'), new AbortController().signal));

    const body = (opencodePrompts[0] as { body: { parts: Array<Record<string, unknown>> } }).body;
    const files = body.parts.filter((p) => p.type === 'file') as Array<{ mime: string; filename: string }>;
    expect(files.map((f) => f.filename)).toEqual(['attachment-1.jpeg', 'attachment-2.png']);
    expect(files.map((f) => f.mime)).toEqual(['image/jpeg', 'image/png']);
  });

  it('still describes a video, and attaches nothing for it', async () => {
    const a = new OpencodeAdapter();
    a.registerToolCatalog(catalog());
    await drain(a.invoke(input(withVideo, 'glm', 'z-ai/glm-5.2'), new AbortController().signal));
    const body = (opencodePrompts[0] as { body: { parts: Array<Record<string, unknown>> } }).body;
    expect(body.parts.filter((p) => p.type === 'file')).toEqual([]);
    const text = body.parts.find((p) => p.type === 'text') as { text: string };
    expect(text.text).toContain('cannot watch it');
    expect(text.text).toContain('video/mp4');
  });
});

// ADK takes a text prompt and nothing else, so the picture is described there.
// One assertion covers it: it builds its prompt through the same function, with
// the describing default.
describe('the engine that cannot receive an image says so', () => {
  it('describes the image in the text prompt', () => {
    const prompt = firstTurnPrompt(withImage);
    expect(prompt).toContain('what does this show?');
    expect(prompt).toContain('image/png');
    expect(prompt).toContain('cannot see it');
  });

  it('carries the description the person gave', () => {
    expect(firstTurnPrompt(withImage)).toContain('a bar chart');
  });

  // The specific regression. Before the image member existed this function
  // returned '' for any content it did not recognise, and '' is filtered out —
  // so the turn reaching the engine would have been the question alone.
  it('never renders an image as nothing', () => {
    const imageOnly: PlatformMessage[] = [
      { role: 'user', content: [{ type: 'media', mimeType: 'image/png', dataBase64: 'AAAA' }] },
    ];
    expect(firstTurnPrompt(imageOnly).trim().length).toBeGreaterThan(0);
    expect(firstTurnPrompt(imageOnly, { carriesImages: true }).trim().length).toBeGreaterThan(0);
  });

  it('tells the model not to guess from the file type', () => {
    expect(firstTurnPrompt(withImage)).toContain('do not describe it');
  });
});

// A video reaching one of these engines is described with the right VERB. The
// distinction matters: "you cannot see this" about a clip reads as a model that
// was shown a still and failed, rather than one that was never sent a video.
describe('video is described with the verb that fits it', () => {
  it('says watch, not see — on the describing engine and the carrying ones', () => {
    for (const opts of [{}, { carriesImages: true }]) {
      const prompt = firstTurnPrompt(withVideo, opts);
      expect(prompt).toContain('cannot watch it');
      expect(prompt).toContain('video/mp4');
      expect(prompt).toContain('what happens at the end?');
    }
  });

  it('is never counted as an attachment', () => {
    expect(attachedImages(withVideo)).toEqual([]);
  });
});

describe('history replay keeps the picture visible', () => {
  it('mentions an image in a prior turn rather than dropping it', () => {
    const prompt = firstTurnPrompt(withHistoryImage);
    expect(prompt).toContain('Conversation so far');
    expect(prompt).toContain('image/jpeg');
    expect(prompt).toContain('and the trend?');
  });

  it('numbers the attachments through the history and the current turn alike', () => {
    const prompt = firstTurnPrompt(withHistoryImage, { carriesImages: true });
    expect(prompt).toContain('attachment 1');
    expect(prompt).toContain('attachment 2');
    expect(attachedImages(withHistoryImage).map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/png']);
  });
});
