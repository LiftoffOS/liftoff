// Where a Vertex request goes, and whose account it lands in.
//
// Vertex is the one vendor where the credential is not the whole of what
// changes: the project and the location are named in the URL, so switching
// accounts means rewriting the request, not just the header. These two
// functions are the whole of that arithmetic, and both have a failure mode that
// is silent — a wrong host resolves nowhere, and a wrong project 403s with a
// message about permissions rather than about routing.

import { vertexHostForLocation } from '../vertex-token';
import { getManagedSubstitution } from '../managed-fallback';

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue('adc-token'),
  })),
  JWT: jest.fn(),
}));

jest.mock('../../llm/client', () => ({ purposeToGroup: () => 'agent-execution' }));
jest.mock('../../infrastructure/secrets', () => ({
  getAnthropicApiKeyForGroup: jest.fn(),
  getOpenAIApiKeyForGroup: jest.fn(),
  getOpenRouterApiKey: jest.fn(),
}));

describe('vertexHostForLocation', () => {
  it('prefixes a region', () => {
    expect(vertexHostForLocation('us-west1')).toBe('us-west1-aiplatform.googleapis.com');
    expect(vertexHostForLocation('europe-west4')).toBe('europe-west4-aiplatform.googleapis.com');
  });

  it('treats `global` as its own endpoint, not a region prefix', () => {
    // `global-aiplatform.googleapis.com` resolves nowhere. Vertex's
    // meta-endpoint is the bare host, and it is the default this platform uses
    // because it routes to wherever a model is actually served.
    expect(vertexHostForLocation('global')).toBe('aiplatform.googleapis.com');
  });
});

describe('the managed Google fallback', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.GCP_PROJECT_ID = 'example-control-staging';
    process.env.GCP_LOCATION = 'us-west1';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('substitutes Liftoff ADC and Liftoff project when the customer key is declined', async () => {
    // Same service on both sides, which is what makes this possible at all: the
    // managed path IS Vertex, so falling back is a token and a project rather
    // than a different protocol.
    const substitution = await getManagedSubstitution('google', 'agent_invocation');
    expect(substitution).not.toBeNull();
    expect(substitution!.apiKey).toBe('adc-token');
    expect(substitution!.originOverride).toBe('https://us-west1-aiplatform.googleapis.com');
  });

  it('rewrites the project and location the path names', async () => {
    // Sending the CUSTOMER's project with Liftoff's token would 403 — their
    // project has never heard of our identity — and that reads as a second
    // failure rather than as a fallback.
    const substitution = await getManagedSubstitution('google', 'agent_invocation');
    const rewritten = substitution!.rewritePath!(
      'v1/projects/customer-prod-1234/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(rewritten).toBe(
      'v1/projects/example-control-staging/locations/us-west1/publishers/google/models/gemini-2.5-flash:generateContent',
    );
  });

  it('leaves the model and the verb alone', async () => {
    // Only the account changes. Rewriting more than the account would silently
    // serve a different model than the one the run resolved to.
    const substitution = await getManagedSubstitution('google', 'agent_invocation');
    const rewritten = substitution!.rewritePath!(
      'v1/projects/p/locations/l/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent',
    );
    expect(rewritten).toContain('gemini-3.1-pro-preview:streamGenerateContent');
  });

  it('declines to substitute when Liftoff has no project configured', async () => {
    // Better to return the customer's decline than to send a request that
    // cannot name a project.
    delete process.env.GCP_PROJECT_ID;
    expect(await getManagedSubstitution('google', 'agent_invocation')).toBeNull();
  });
});
