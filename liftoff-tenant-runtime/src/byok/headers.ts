// The headers the BYOK gateway speaks, mirrored from platform-backend's
// src/byok-gateway/headers.ts. Two services, one vocabulary; a rename on either
// side has to be made on both.
//
// No imports, deliberately. These are read from inside the vendor adapters and
// the LLM providers, which have to keep loading in the certification and canary
// harnesses where no platform callback is configured.

/**
 * Where the per-run gateway token travels.
 *
 * A header of our own rather than `Authorization`, because the Vertex SDKs fill
 * that one in themselves with an Application Default Credentials token before
 * the request leaves the process. Putting the run's credential there would have
 * it overwritten by Liftoff's identity on its way out. Both Vertex SDKs let a
 * caller add an extra header, so the two never contend for the same slot.
 */
export const BYOK_TOKEN_HEADER = 'x-byok-token';

// The gateway also sets `x-byok-declined` and `x-byok-served-by`
// on its responses. Neither is declared here, because nothing in the runtime
// reads them and a constant with no reader is a lever that suggests a mechanism
// that is not there.
//
// It is worth saying why they are not needed. Both existed for a caller that had
// to run its OWN fallback when its credential was refused — and no caller does:
// the gateway substitutes Liftoff's credential itself for all four vendors,
// including Google, whose managed path is the same Vertex service the customer's
// service account reaches. The turn completes without the caller learning that
// the account changed, which is the point.
