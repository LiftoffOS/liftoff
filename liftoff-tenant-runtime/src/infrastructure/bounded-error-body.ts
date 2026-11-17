// Bounded reads of HTTP error bodies (I2).
//
// The pattern everywhere in this codebase is `await response.text()` on a
// non-OK response, to put the server's explanation in a log line. That read is
// unbounded in two ways, and both are reachable from a hostile or simply broken
// upstream:
//
//   1. Size. A server can declare — or just stream — an arbitrarily large body.
//      The text is only ever shown truncated in a log, so reading megabytes to
//      print 500 characters is pure downside.
//
//   2. Time. A server can open the body and then stall: no more bytes, no
//      close. `response.text()` waits for the stream to end, so the caller
//      hangs. Where that caller is a tool dispatch inside an agent turn, the
//      whole turn hangs with it — the request timeout that governs the
//      HEADERS has already been satisfied by then.
//
// This reads with a byte cap AND a wall-clock deadline, cancelling the body when
// either is hit. Never throws: the caller is already on an error path, and the
// diagnostic text must not become a second failure.

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 5_000;

export interface BoundedErrorTextOptions {
  maxBytes?: number;
  deadlineMs?: number;
}

/**
 * Read an error response body, bounded by size and time.
 *
 * Returns whatever was read before the bound was hit (with a marker when
 * truncated), or an empty string when the body could not be read at all.
 */
export async function readBoundedErrorText(
  response: { body?: ReadableStream<Uint8Array> | null; text?: () => Promise<string> },
  options: BoundedErrorTextOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  // No stream to read incrementally (a mocked response, or a runtime without
  // ReadableStream): fall back to text(), still bounded by the deadline so a
  // stalled body cannot hang the caller.
  if (!response.body) {
    if (typeof response.text !== 'function') return '';
    return withDeadline(
      response.text().then((t) => t.slice(0, maxBytes)),
      deadlineMs,
      '',
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  let truncated = false;

  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Decode only up to the cap, then stop pulling.
        const keep = value.byteLength - (total - maxBytes);
        if (keep > 0) chunks.push(decoder.decode(value.subarray(0, keep), { stream: false }));
        truncated = true;
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })();

  const finished = await withDeadline(readAll.then(() => true), deadlineMs, false);
  if (!finished) truncated = true;

  // Cancelling releases the socket whether we stopped on the cap, the deadline,
  // or normally. Failure here is not interesting — the body is already read.
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }

  const text = chunks.join('');
  // A marker on its own says nothing useful. When the read produced no bytes at
  // all — a socket reset, or a stall before the first chunk — return empty
  // rather than a bare "… [truncated]", which would read like a real (if odd)
  // server response in the log.
  if (!text) return '';
  return truncated ? `${text}… [truncated]` : text;
}

/** Resolve with `fallback` if the promise has not settled in time. The pending
 *  promise is left to settle on its own; its result is simply ignored. */
async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
