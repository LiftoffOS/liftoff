// Ask OpenRouter what the call cost.
//
// For a model reached through the gateway, a RATE cannot be accurate in
// principle: one model is served by many endpoints at different prices — Kimi K3
// by nineteen, spanning $1.03 to $4.50 per million input tokens — and nothing in
// a price list says which one took a given request. The estimate therefore has
// to choose an error, and `sync-model-pricing` chooses to over-attribute (max
// across endpoints) because under-attributing loses money silently. Measured
// against the live endpoints API, that max runs about 2x the median, so a
// customer spends Operating Units at roughly twice the cost actually incurred.
//
// `usage: { include: true }` replaces the whole question with an answer: the
// gateway returns `usage.cost` for the request it actually served. The estimate
// stays as the fallback, so a response without a cost prices exactly as it did
// before.
//
// WHY A FETCH WRAPPER. The SDK provider is constructed around a raw OpenAI
// client and offers no per-request hook for a non-standard body field, so the
// body is the only place to put it. Wrapping fetch is already the established
// pattern for cross-cutting concerns on this client (see
// request-shape-on-rejection), and doing it here means every request the SDK
// makes carries the flag — including ones this repo does not construct itself,
// which an per-call-site approach would miss.

/** Request bodies this may touch: the chat-completions call and nothing else.
 *  A models or credits GET has no body and no use for the field. */
function isChatCompletions(url: string): boolean {
  return url.includes('/chat/completions');
}

/**
 * Wrap `fetch` so every chat-completions request asks for usage accounting.
 *
 * Deliberately conservative about what it will touch:
 *   - only POSTs to /chat/completions
 *   - only bodies that parse as a JSON object
 *   - never overwrites a `usage` field the caller already set
 *
 * Any body it cannot confidently rewrite is forwarded byte-for-byte. A dropped
 * flag costs accuracy and falls back to the estimate; a corrupted body fails the
 * run, so the asymmetry decides the error.
 */
export function fetchRequestingUsageAccounting(inner: typeof fetch): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'POST' || !isChatCompletions(href) || typeof init?.body !== 'string') {
      return inner(url, init);
    }
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return inner(url, init);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return inner(url, init);
    const obj = body as Record<string, unknown>;
    if ('usage' in obj) return inner(url, init);
    return inner(url, {
      ...init,
      headers: withoutContentLength(init.headers),
      body: JSON.stringify({ ...obj, usage: { include: true } }),
    });
  }) as typeof fetch;
}

/**
 * The caller's headers, less `content-length`.
 *
 * The OpenAI SDK sets `content-length` from the body it serialised, and the
 * body sent here is longer by the flag. Node's fetch refuses a request whose
 * body does not match that header (UND_ERR_REQ_CONTENT_LENGTH_MISMATCH), which
 * the SDK reports as "Connection error.", so every chat request on this
 * provider failed before it left the process. With the header gone, fetch
 * computes it from the body actually sent.
 */
function withoutContentLength(headers: RequestInit['headers']): Headers {
  const out = new Headers(headers);
  out.delete('content-length');
  return out;
}
