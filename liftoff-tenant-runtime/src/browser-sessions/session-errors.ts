// The two ways a thread can fail to get a browser, as types.
//
// Deliberately a LEAF module: no imports, so anything that needs to recognise
// these can do it without pulling in the vendor clients behind
// session-vendor-proxy. That is not tidiness. The ensure-error classifier turns
// a failure into the copy a person reads in the pane, and when it imported the
// proxy to reach these classes it inherited the whole vendor tree — which any
// caller that had mocked the proxy then saw as `instanceof` against undefined,
// so the classifier stopped classifying anything at all.

/** No vendor can own this thread's browser.
 *
 *  Since the platform's own Browser Use key backs one by default, reaching this
 *  means the workspace connected nothing AND an operator has switched the
 *  platform browser off, not merely that nobody bought a browser. */
export class NoSessionVendorConnected extends Error {
  constructor() {
    super('no browser vendor is available for this tenant');
    this.name = 'NoSessionVendorConnected';
  }
}

/** Every browser this vendor's plan allows is already open.
 *
 *  Transient by nature: a slot frees the moment any session stops, which the
 *  reaper guarantees happens within the idle window. Callers surface it as a
 *  retryable refusal rather than a failure, because "try again shortly" is the
 *  true answer and "could not start a browser" is not. */
export class SessionVendorAtCapacity extends Error {
  constructor(
    public readonly vendor: string,
    public readonly open: number,
    public readonly ceiling: number,
  ) {
    super(
      `all ${ceiling} ${vendor} browser sessions are in use (${open} open); ` +
      'one frees as soon as a session ends',
    );
    this.name = 'SessionVendorAtCapacity';
  }
}

/** The vendor no longer has this session.
 *
 *  A pane session lives at the vendor and is released there on its own idle
 *  timeout, minutes before or after anything here notices. Every operation on
 *  a released session fails the same way, and the failure is NOT an internal
 *  error: the session is simply gone, and the caller's answer is to open a new
 *  one. Recognised from the vendor's own signal rather than from a message,
 *  except where the message is all a client gives: Steel raises 410 with
 *  "is released", Browser Use and Browserbase answer 404 on a session that has
 *  ended.
 *
 *  Leaf, like the two above, for the same reason. */
export function isVendorSessionGone(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (status === 404 || status === 410) return true;
  const message = ((err as { message?: unknown } | null)?.message ?? '').toString().toLowerCase();
  return message.includes('is released')
    || message.includes('session is not running')
    || message.includes('browser session is not running');
}
