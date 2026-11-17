// Resolving a `$ref` that points anywhere in the document, not just at
// `#/components`.
//
// A `$ref` is allowed to name ANY node by JSON pointer, and real providers do:
// DigitalOcean writes every shared parameter as
// `#/paths/~1v2~1account~1keys~1%7Bssh_key_identifier%7D/get/parameters/0`,
// pointing at the first parameter of another operation. A resolver that only
// understands `#/components/<section>/<name>` hands that node back unchanged,
// and the caller then reads a `$ref` object as though it were the thing it
// points at: no `name`, no `in`, no `schema`. For the subset check that meant
// 330 ordinary parameters on one specification reported as
// `parameter "(unnamed)" in an unsupported location "undefined"`, and the whole
// provider refused. For the generator it would mean an operation quietly
// losing its parameters.
//
// Two escapes, both required by RFC 6901 and both present in that example:
// `~1` is `/` and `~0` is `~`, in that order, and a pointer may be
// percent-encoded because it travels in a URI fragment.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

/** How deep a chain of `$ref`s may go before we call it a cycle. A pointer
 *  that refs a pointer is legal; one that refs itself is not, and neither is
 *  worth unwinding further than this. */
const MAX_HOPS = 8;

/** RFC 6901 unescaping, `~1` before `~0` so a literal `~1` survives. */
function unescapeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A stray `%` is not an escape. Take the segment as written rather than
    // throwing away a pointer that is otherwise fine.
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Walk one local JSON pointer (`#/a/b/0`) from the document root. */
function walk(document: Json, pointer: string): Json | undefined {
  if (pointer === '#' || pointer === '#/') return document;
  const segments = pointer.slice(2).split('/');
  let node: any = document;
  for (const raw of segments) {
    if (node === null || node === undefined) return undefined;
    const key = unescapeSegment(raw);
    node = Array.isArray(node) ? node[Number(key)] : node[key];
  }
  return node as Json | undefined;
}

/**
 * Resolve `node` if it is a local `$ref`, following a short chain.
 *
 * Returns the node unchanged when it is not a ref, and `undefined` only when a
 * ref names something the document does not contain — a caller that treats
 * that as "leave it alone" behaves exactly as it did before this existed.
 * An EXTERNAL ref (one that names another file or a URL) is deliberately not
 * followed: the fetcher reads one document and nothing else may be reached
 * from a tenant-supplied specification.
 */
export function resolveRef(node: Json | undefined, document: Json): Json | undefined {
  let current = node;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const ref = current?.$ref;
    if (typeof ref !== 'string') return current;
    if (!ref.startsWith('#/')) return current;
    const target = walk(document, ref);
    if (target === undefined) return undefined;
    if (target === current) return current;
    current = target;
  }
  return current;
}
