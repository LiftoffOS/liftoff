// Connector availability — thin re-export from the connector-service cache.
//
// Before Phase 1c this file was the canonical source of truth for which
// connector types are functional end-to-end. After Phase 1c the cache in
// src/connectors/connector-service-cache.ts is authoritative — populated
// by the connector-service's GetFunctionalTypes RPC at startup, with a
// static fallback for when the flag is off OR the RPC is unreachable.
//
// The exported API is preserved so existing callers compile unchanged:
//   - `FUNCTIONAL_CONNECTOR_TYPES` — a Set<string>. Now a live view of
//     the cache. `.has(x)` still works the same way.
//
// New callers should prefer `isFunctionalConnectorType(t)` from the
// cache module directly — it's explicit about the async initialization.

import { getFunctionalConnectorTypes } from '../connectors/connector-service-cache';

// Proxy Set that reads live from the cache on every call. We can't just
// export a mutable Set<string> because JavaScript references freeze at
// import time — the cache updates would be invisible to callers that
// pinned the reference.
//
// Using a Proxy lets callers keep writing `FUNCTIONAL_CONNECTOR_TYPES.has(t)`
// without noticing that the underlying Set changes as the cache refreshes.
export const FUNCTIONAL_CONNECTOR_TYPES: ReadonlySet<string> = new Proxy(new Set<string>(), {
  get(_target, prop) {
    const live = getFunctionalConnectorTypes();
    // `Reflect.get(live, prop, live)` invokes getters (e.g. `size`) on the
    // live Set's [[Prototype]] chain with the right receiver. Methods
    // (`has`, `forEach`, the iterator) are bound so `this` is the live Set.
    const value = Reflect.get(live, prop, live);
    return typeof value === 'function' ? value.bind(live) : value;
  },
}) as ReadonlySet<string>;
