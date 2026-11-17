/**
 * Google (Gemini via Vertex) urlContext wiring tests.
 *
 * The provider:
 *   - appends `{ urlContext: {} }` to the tools array when serverTools contains web_fetch
 *   - counts response.candidates[0].urlContextMetadata.urlMetadata.length as webFetchRequests
 */

jest.mock('@google-cloud/vertexai', () => {
  const FunctionCallingMode = { AUTO: 'AUTO', ANY: 'ANY' } as const;
  class FakeGenerativeModel {
    private opts: any;
    constructor(opts: any) { this.opts = opts; }
    async generateContent(_args: any) {
      return {
        response: {
          candidates: [{
            content: { parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
            urlContextMetadata: {
              urlMetadata: [{ retrievedUrl: 'https://a' }, { retrievedUrl: 'https://b' }],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      };
    }
    // Tests can inspect the options passed to the model:
    _opts() { return this.opts; }
  }
  class VertexAI {
    getGenerativeModel(opts: any) { return new FakeGenerativeModel(opts); }
  }
  return { VertexAI, FunctionCallingMode };
});

import { GoogleProvider } from '../google';

describe('Google provider — urlContext wiring', () => {
  let provider: GoogleProvider;
  beforeAll(async () => {
    process.env.GCP_PROJECT_ID = 'test-project';
    provider = (await GoogleProvider.create())!;
  });

  it('reports webFetchRequests from urlContextMetadata', async () => {
    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: [{ name: 'web_fetch' }],
    });
    expect(res.usage?.webFetchRequests).toBe(2);
  });

  it('webFetchRequests is 0 when no urlContextMetadata is returned', async () => {
    // Patch the fake to omit urlContextMetadata for this call.
    const vertex = (provider as any).vertexAI;
    const orig = vertex.getGenerativeModel.bind(vertex);
    jest.spyOn(vertex, 'getGenerativeModel').mockImplementation((opts: any) => {
      const m = orig(opts);
      m.generateContent = async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      });
      return m;
    });
    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: [{ name: 'web_fetch' }],
    });
    expect(res.usage?.webFetchRequests).toBe(0);
  });
});
