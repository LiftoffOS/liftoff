// Writing the request body the way the provider asked for it.
//
// A model sends an object. Most providers want that as JSON, and the ones that
// do not want the same object form-encoded: Stripe's entire API is
// `application/x-www-form-urlencoded`, and so is most of Slack's. Refusing
// them cost 536 of the 601 remaining offences across ten providers and, in
// Stripe's case, all 445 of its operations.
//
// The encoding is the one the specification declared, never a guess: the
// operation carries the media type its body schema was read from, and an
// operation that declares nothing is JSON, which is what a dispatcher writes
// anyway.

/** Form encoding, as OpenAPI's default `form` style produces it.
 *
 *  Three shapes, and the last two are why `new URLSearchParams(object)` is not
 *  enough:
 *
 *    scalar   `a=1`
 *    list     `a=1&a=2`       — the key repeated, the same as a query array
 *    object   `a[b]=1`        — bracketed, which is how every provider that
 *                               takes nested form data reads it back
 *
 *  A nested `undefined` or `null` is dropped rather than written as the word:
 *  a provider reading `"null"` as a value is a bug that looks like data. */
export function encodeForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    appendBracketed(params, key, value, { indexArrays: false });
  }
  return params.toString();
}

/**
 * Write one value under `key`, bracketing whatever is nested in it.
 *
 * The only thing that differs between the two callers is what a LIST looks
 * like. A form repeats the key — `a=1&a=2` — and a `deepObject` query
 * parameter indexes it — `a[0]=1&a[1]=2`, which is how Stripe writes `expand`
 * and how anything else declaring that style reads its arrays back. Objects
 * are bracketed identically either way, all the way down.
 */
export function appendBracketed(
  params: URLSearchParams,
  key: string,
  value: unknown,
  opts: { indexArrays: boolean },
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendBracketed(params, opts.indexArrays ? `${key}[${index}]` : key, item, opts);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendBracketed(params, `${key}[${k}]`, v, opts);
    }
    return;
  }
  params.append(key, String(value));
}

/** What to send, and what to say it is. */
export function encodeBody(
  body: Record<string, unknown>,
  mediaType: string | undefined,
): { payload: string; contentType: string } {
  if (mediaType === 'application/x-www-form-urlencoded') {
    return { payload: encodeForm(body), contentType: 'application/x-www-form-urlencoded' };
  }
  return { payload: JSON.stringify(body), contentType: mediaType ?? 'application/json' };
}
