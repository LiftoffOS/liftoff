// The three Google engines call ONE Vertex endpoint from one deploy env.
//
// A cache reading is a property of the endpoint as much as of the request.
// The ADK adapter resolved its project and region from `GOOGLE_CLOUD_*` alone
// while the Gen AI SDK adapter and the CLI adapter read the repo-standard
// `GCP_*` pair first, so a deploy that set both could put ADK on one regional
// endpoint and genai on another — and a fixed-prompt benchmark that then
// compared the two compared regions, not engines. This pins all three to the
// same resolution, and the boot check to the same acceptance.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The ADK package ships ESM only; the adapter module is what is under test,
// not the SDK, and the resolver reads nothing off it.
jest.mock('@google/adk', () => {
  class Noop { constructor(public o: unknown) {} }
  return {
    LlmAgent: Noop, Runner: Noop, FunctionTool: Noop, InMemorySessionService: Noop,
    TokenBasedContextCompactor: Noop, LlmSummarizer: Noop, Gemini: Noop,
    getFunctionCalls: () => [], getFunctionResponses: () => [], isFinalResponse: () => false,
  };
});

import { adkVertexTarget } from '../gemini-adk';
import { validateEnabledEngines } from '../../certification/startup-validation';

const cases: Array<[string, NodeJS.ProcessEnv, { project: string | undefined; location: string }]> = [
  ['the repo-standard pair the deploy sets', { GCP_PROJECT_ID: 'p-std', GCP_LOCATION: 'us-west1' }, { project: 'p-std', location: 'us-west1' }],
  ["genai's own names", { GOOGLE_CLOUD_PROJECT: 'p-genai', GOOGLE_CLOUD_LOCATION: 'europe-west4' }, { project: 'p-genai', location: 'europe-west4' }],
  ['both set: the repo-standard pair wins, as it does on the other two engines', { GCP_PROJECT_ID: 'p-std', GCP_LOCATION: 'us-west1', GOOGLE_CLOUD_PROJECT: 'p-genai', GOOGLE_CLOUD_LOCATION: 'europe-west4' }, { project: 'p-std', location: 'us-west1' }],
  ['the Vertex region name between the two', { GOOGLE_CLOUD_PROJECT: 'p', VERTEX_LOCATION: 'asia-east1' }, { project: 'p', location: 'asia-east1' }],
  ['no region at all: the global endpoint', { GCP_PROJECT_ID: 'p' }, { project: 'p', location: 'global' }],
];

describe('the ADK engine resolves its Vertex target the way the Gen AI SDK engine does', () => {
  it.each(cases)('%s', (_name, env, expected) => {
    expect(adkVertexTarget(env)).toEqual(expected);
  });
});

describe('the boot check accepts what the adapter accepts', () => {
  const sdkPresent = () => '/resolved';
  const binaryPresent = () => true;

  it('passes ADK on the repo-standard pair alone', () => {
    const { ok, reports } = validateEnabledEngines(
      { GOOGLE_ENGINE: 'adk', GOOGLE_GENAI_USE_VERTEXAI: 'true', GCP_PROJECT_ID: 'p', GCP_LOCATION: 'us-west1' },
      sdkPresent,
      binaryPresent,
    );
    expect(reports.find((r) => r.engine === 'google-adk')!.missingConfig).toEqual([]);
    expect(ok).toBe(true);
  });

  it('still names the canonical spelling of each missing group', () => {
    const { reports } = validateEnabledEngines({ GOOGLE_ENGINE: 'adk', GCP_PROJECT_ID: 'p' }, sdkPresent, binaryPresent);
    expect(reports.find((r) => r.engine === 'google-adk')!.missingConfig)
      .toEqual(['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_LOCATION']);
  });
});
