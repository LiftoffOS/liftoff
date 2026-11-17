// Which of a workspace's connectors a vendor call may draw its credential from.
//
// vendor-scope.ts decides WHICH vendors a run may use and through which
// connector ids. This is the value that carries that answer from the place a
// vendor is chosen — the router's chain, the browser session spawn — down to
// getWebToolCredential, so the credential pool hands out only a bound
// connector's key.
//
// A REQUIRED parameter, not ambient context, on purpose. Every credential read
// in the tree has to say what it is scoped to, and the compiler refuses one
// that does not; a read that legitimately runs as the workspace rather than
// as a team (a quota monitor, a webhook secret, an operation on a session the
// workspace already holds) says so by passing ANY_CONNECTOR, where a reader
// can see it. The defect this exists to end — "any connector of that type"
// chosen by default — would come straight back through an ambient scope the
// first time a new dispatch point forgot to establish one, and nothing would
// tell anybody.
//
// Three values, and the third is the one an ambient scope could not express:
// a vendor the workspace connected but the team is NOT bound to must resolve
// NO workspace key at all, so that a platform-funded vendor (steel,
// browser_use) drops to the platform key rather than quietly onto the
// unbound account.

import type { WebToolVendor } from './web-tool-secrets';
import type { WebVendorScope } from './vendor-scope';

export interface CredentialScope {
  /** The connector ids a credential may come from: a non-empty set names the
   *  bound connectors; null is any of the workspace's connectors of the
   *  vendor's type; an EMPTY set is none of them (the workspace connected the
   *  vendor, the team is not bound to it). */
  connectorIds: ReadonlySet<string> | null;
}

/** Any of the workspace's connectors of the type. The scope of a path that
 *  runs as the workspace rather than as a team; named so that a reader of the
 *  call site can see the choice was made. */
export const ANY_CONNECTOR: CredentialScope = Object.freeze({ connectorIds: null });

/** None of the workspace's connectors. getWebToolCredential answers
 *  VendorNotConnected, which a platform-funded client turns into the
 *  platform key and a connector-only client turns into the next vendor. */
export const NO_WORKSPACE_CONNECTOR: CredentialScope = Object.freeze({ connectorIds: new Set<string>() });

/** The credential scope for one vendor of a run's vendor scope: the bound
 *  connector ids when the binding named any; any connector of the type when
 *  the binding named the type alone (the legacy shape); no workspace
 *  connector when the run may not use this vendor at all. */
export function scopeFor(scope: WebVendorScope, vendor: WebToolVendor): CredentialScope {
  if (!scope.vendors.has(vendor)) return NO_WORKSPACE_CONNECTOR;
  const ids = scope.connectorIds.get(vendor);
  return ids && ids.size > 0 ? { connectorIds: ids } : ANY_CONNECTOR;
}
