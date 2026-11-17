// The `google` door serves two request grammars, and one of them cannot reach
// Vertex untranslated.
//
// Google publishes the same models behind two APIs, and `@google/genai` picks one
// from a single boolean: `vertexai: false` gives `v1beta/models/{m}:{method}` with
// the credential in `x-goog-api-key`, and `vertexai: true` gives
// `v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{method}` with an
// OAuth bearer. `GOOGLE_GEMINI_BASE_URL` is read only in the first mode.
//
// Every Google credential this platform can serve is Vertex, so the door's
// upstream is always the second grammar — while the two clients that are handed
// only a base URL and a key (the Gemini CLI, the coding runner) speak the first,
// because neither can send a header the gateway would recognise. Untranslated,
// those requests reach Vertex as `/v1beta/models/gemini-x:streamGenerateContent`
// and 404 in a way that reads like a bad model id.

import {
  googleUpstreamPath,
  rewriteVertexAccount,
  vertexPathForGeminiApiPath,
} from '../google-path';

const LIFTOFF = { project: 'example-control-staging', location: 'global' };
const CUSTOMER = { project: 'customer-prod-1234', location: 'europe-west4' };

describe('a Gemini Developer API path becomes a Vertex path', () => {
  it('names the account Vertex requires and the publisher it requires', () => {
    expect(
      vertexPathForGeminiApiPath(
        'v1beta/models/gemini-3.5-flash:generateContent',
        LIFTOFF.project,
        LIFTOFF.location,
      ),
    ).toBe(
      'v1/projects/example-control-staging/locations/global'
      + '/publishers/google/models/gemini-3.5-flash:generateContent',
    );
  });

  it('keeps the streaming method and its query string', () => {
    // `?alt=sse` is how the SDK asks for a server-sent-event stream. Dropping it
    // turns a stream into one buffered response, which the adapter would wait on
    // until the turn's deadline.
    expect(
      vertexPathForGeminiApiPath(
        'v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
        LIFTOFF.project,
        LIFTOFF.location,
      ),
    ).toBe(
      'v1/projects/example-control-staging/locations/global'
      + '/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
    );
  });

  it('maps the API VERSION, because Vertex serves neither v1beta nor v1alpha', () => {
    // Vertex serves `v1` and `v1beta1`. Passing `v1beta` through is the same 404
    // by a different route.
    const v1beta = vertexPathForGeminiApiPath('v1beta/models/m:countTokens', 'p', 'l');
    const v1alpha = vertexPathForGeminiApiPath('v1alpha/models/m:countTokens', 'p', 'l');
    expect(v1beta!.startsWith('v1/projects/')).toBe(true);
    expect(v1alpha!.startsWith('v1beta1/projects/')).toBe(true);
  });

  it('translates every method the CLI can reach, not just generateContent', () => {
    for (const method of ['generateContent', 'streamGenerateContent', 'countTokens', 'embedContent']) {
      expect(vertexPathForGeminiApiPath(`v1beta/models/m:${method}`, 'p', 'l'))
        .toBe(`v1/projects/p/locations/l/publishers/google/models/m:${method}`);
    }
  });

  it('tolerates a leading slash, which is how the router hands it over', () => {
    expect(vertexPathForGeminiApiPath('/v1beta/models/m:generateContent', 'p', 'l'))
      .toBe('v1/projects/p/locations/l/publishers/google/models/m:generateContent');
  });
});

describe('what it deliberately leaves alone', () => {
  it('a path that is ALREADY Vertex', () => {
    // Null means "not mine". Rewriting a path that does not need it is how a
    // proxy corrupts a request, and every SDK client in this estate sends this
    // grammar already.
    expect(
      vertexPathForGeminiApiPath(
        'v1/projects/p/locations/l/publishers/google/models/m:generateContent',
        'x',
        'y',
      ),
    ).toBeNull();
  });

  it('a TUNED model, which has no publishers/google equivalent', () => {
    // A tuned model is the customer's own resource. Forwarding it to a path that
    // names Google as the publisher would reach a DIFFERENT model, which is worse
    // than the 404 the untranslated path produces.
    expect(vertexPathForGeminiApiPath('v1beta/tunedModels/t123:generateContent', 'p', 'l'))
      .toBeNull();
  });

  it('anything that is not a model request at all', () => {
    for (const path of ['v1beta/models', 'v1beta/files/f1', 'health', '']) {
      expect(vertexPathForGeminiApiPath(path, 'p', 'l')).toBeNull();
    }
  });

  it('every path, when it has no account to name', () => {
    // Without a project there is nothing to translate TO, and inventing one would
    // send the request to somebody else's Vertex.
    expect(vertexPathForGeminiApiPath('v1beta/models/m:generateContent', '', 'global')).toBeNull();
    expect(vertexPathForGeminiApiPath('v1beta/models/m:generateContent', 'p', '')).toBeNull();
  });
});

describe('swapping the account a Vertex path names', () => {
  it('replaces the project and the location together', () => {
    // Sending the customer's project with Liftoff's token would 403 — their
    // project has never heard of our identity — and that reads as a second
    // failure rather than as a fallback.
    expect(
      rewriteVertexAccount(
        'v1/projects/customer-prod-1234/locations/europe-west4'
        + '/publishers/google/models/gemini-3.5-flash:generateContent',
        LIFTOFF.project,
        LIFTOFF.location,
      ),
    ).toBe(
      'v1/projects/example-control-staging/locations/global'
      + '/publishers/google/models/gemini-3.5-flash:generateContent',
    );
  });

  it('leaves the model and the verb alone', () => {
    // Only the account changes. Rewriting more than the account would silently
    // serve a different model than the one the run resolved to.
    const out = rewriteVertexAccount(
      'v1/projects/p/locations/l/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent',
      'q',
      'm',
    );
    expect(out).toContain('gemini-3.1-pro-preview:streamGenerateContent');
  });
});

describe('the one function a caller uses', () => {
  // Both halves in the one order that is correct, so no caller has to know it.
  it('translates a Gemini-API path', () => {
    expect(googleUpstreamPath('v1beta/models/m:generateContent', LIFTOFF.project, LIFTOFF.location))
      .toBe(
        'v1/projects/example-control-staging/locations/global'
        + '/publishers/google/models/m:generateContent',
      );
  });

  it('swaps the account on a Vertex path', () => {
    expect(
      googleUpstreamPath(
        'v1/projects/other/locations/us-central1/publishers/google/models/m:generateContent',
        LIFTOFF.project,
        LIFTOFF.location,
      ),
    ).toBe(
      'v1/projects/example-control-staging/locations/global'
      + '/publishers/google/models/m:generateContent',
    );
  });

  it('is idempotent, so a re-entry cannot double anything', () => {
    const once = googleUpstreamPath('v1beta/models/m:generateContent', 'p', 'l');
    expect(googleUpstreamPath(once, 'p', 'l')).toBe(once);
  });

  it('serves a CUSTOMER account as readily as Liftoff\'s', () => {
    // The same translation, against their project, because on the BYOK path the
    // token is theirs. Reading Liftoff's project there would 403 on our own
    // identity.
    expect(
      googleUpstreamPath('v1beta/models/m:generateContent', CUSTOMER.project, CUSTOMER.location),
    ).toBe(
      'v1/projects/customer-prod-1234/locations/europe-west4'
      + '/publishers/google/models/m:generateContent',
    );
  });
});
