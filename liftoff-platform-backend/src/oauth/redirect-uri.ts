// Redirect URI classification shared by registration (which decides what a
// client may register) and the consent page (which decides what to show the
// person about where they are going).

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** RFC 8252 §7.3: an http:// URI on a loopback address; the port is free. */
export function isLoopbackUri(uri: URL): boolean {
  // URL.hostname strips brackets from IPv6 literals.
  return uri.protocol === 'http:' && (LOOPBACK_HOSTS.has(uri.hostname) || uri.hostname === '::1');
}

// Schemes a browser would execute or read from rather than hand to a native
// app. Everything else that is not http(s) is a private-use scheme (RFC 8252
// §7.1): the OS routes it to the desktop app that owns it, which is how
// Cursor takes its callback (`cursor://anysphere.cursor-mcp/oauth/callback`).
const NON_REDIRECTABLE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'http:']);

export function isPrivateUseUri(uri: URL): boolean {
  return uri.protocol !== 'https:' && !NON_REDIRECTABLE_SCHEMES.has(uri.protocol);
}
