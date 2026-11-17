// The `google` door serves TWO request shapes, and this is the translation
// between them.
//
// Google publishes the same models behind two APIs with different URL grammars,
// and the `@google/genai` SDK picks one from a single boolean:
//
//   Gemini Developer API   v1beta/models/{model}:{method}
//                          credential in `x-goog-api-key`
//                          selected when `vertexai` is false, and the ONLY mode
//                          in which `GOOGLE_GEMINI_BASE_URL` is read at all
//                          (`getBaseUrl` in the SDK branches on `vertexai`)
//
//   Vertex AI              v1/projects/{p}/locations/{l}/publishers/google/models/{model}:{method}
//                          credential an OAuth bearer
//                          selected when `vertexai` is true, and the mode in
//                          which `GOOGLE_VERTEX_BASE_URL` is read instead
//
// Liftoff's managed Google capacity and a customer's Google credential are both
// VERTEX: a project, a location, and either ADC or a service account. So the
// door's upstream is always the second grammar.
//
// But a client that is only given a base URL and a key speaks the FIRST. That is
// not a hypothetical: it is what the coding runner hands a Google credential
// (`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`) and what the Gemini CLI reads,
// because those two variables are the only pair either of them accepts — the CLI
// offers no way to add a header to a model request, so a bearer the gateway would
// recognise cannot be sent, and the Vertex variables would make it authenticate
// on its own identity instead of the run's.
//
// Without this translation such a request reaches Vertex as
// `/v1beta/models/gemini-x:streamGenerateContent`, which Vertex does not serve.
// The symptom is a 404 that reads like a bad model id.

/** Vertex serves `v1` and `v1beta1`; the Gemini API's `v1beta` is neither.
 *  Mapped rather than passed through, because passing it through is the same 404
 *  by a different route. */
function vertexApiVersion(geminiVersion: string): string {
  return geminiVersion === 'v1alpha' ? 'v1beta1' : 'v1';
}

/**
 * A Gemini Developer API path, as the shape this file translates FROM.
 *
 * `models/` and `tunedModels/` are the two collections that API exposes, and the
 * method is whatever follows the colon (`generateContent`,
 * `streamGenerateContent`, `countTokens`, `embedContent`). Anchored, so a Vertex
 * path — which reaches `models/` only after `publishers/google/` — cannot match.
 */
const GEMINI_API_PATH = /^(v1[a-z0-9]*)\/(models|tunedModels)\/([^/:]+):([A-Za-z]+)$/;

/**
 * The same request, addressed to Vertex, or null when it was already a Vertex
 * request.
 *
 * NULL IS THE COMMON ANSWER and it means "leave this alone". A client built
 * against Vertex — every SDK path in this estate, and the Vertex clients the
 * gateway was written for — already sends the second grammar, and rewriting a
 * path that does not need it is how a proxy corrupts a request.
 *
 * `project` and `location` are the account the request will actually be served
 * on: Liftoff's for a managed substitution, the customer's for their own
 * credential. They are not readable from the inbound path, which is the whole
 * reason the first grammar needs translating rather than editing.
 */
export function vertexPathForGeminiApiPath(
  pathAndQuery: string,
  project: string,
  location: string,
): string | null {
  if (!project || !location) return null;
  const questionMark = pathAndQuery.indexOf('?');
  const path = questionMark >= 0 ? pathAndQuery.slice(0, questionMark) : pathAndQuery;
  const query = questionMark >= 0 ? pathAndQuery.slice(questionMark) : '';

  const match = GEMINI_API_PATH.exec(path.replace(/^\/+/, ''));
  if (!match) return null;
  const [, version, collection, model, method] = match;

  // A tuned model is a customer's own resource and has no `publishers/google`
  // equivalent on Vertex. Left alone deliberately: forwarding it to a path that
  // names Google as the publisher would reach a different model, which is worse
  // than the 404 the untranslated path produces.
  if (collection !== 'models') return null;

  return `${vertexApiVersion(version)}/projects/${project}/locations/${location}`
    + `/publishers/google/models/${model}:${method}${query}`;
}

/**
 * Swap the account a Vertex path names.
 *
 * The other half of the same job, and the one the managed substitution has always
 * done: a customer's project reached with Liftoff's token would 403, because
 * their project has never heard of our identity.
 */
export function rewriteVertexAccount(
  pathAndQuery: string,
  project: string,
  location: string,
): string {
  return pathAndQuery.replace(
    /projects\/[^/]+\/locations\/[^/]+/,
    `projects/${project}/locations/${location}`,
  );
}

/**
 * Both halves, in the one order that is correct.
 *
 * TRANSLATE FIRST, then swap. A translated path already names the destination
 * account, so swapping it afterwards is a no-op; doing it the other way round
 * would try to swap an account out of a path that has none and then translate
 * using the same values, which happens to work and hides the dependency. Stated
 * as one function so no caller has to know the order.
 */
export function googleUpstreamPath(
  pathAndQuery: string,
  project: string,
  location: string,
): string {
  return vertexPathForGeminiApiPath(pathAndQuery, project, location)
    ?? rewriteVertexAccount(pathAndQuery, project, location);
}
