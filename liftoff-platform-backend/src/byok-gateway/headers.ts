// The three headers the BYOK gateway speaks, in a module with no imports.
//
// Separate from router.ts on purpose. The LLM providers need the token header to
// send it, and router.ts pulls in express, the key service and the managed
// fallback — which itself imports the LLM client. Importing the router from a
// provider would close that loop into a require cycle, and the symptom of one
// here is an undefined constant at module init rather than a compile error.

/**
 * Where the per-run gateway token travels.
 *
 * A header of our own rather than `Authorization`, because the Vertex SDKs fill
 * that one in themselves with an Application Default Credentials token before
 * the request leaves the process. Reading the run's credential from there would
 * find Liftoff's identity instead. Both Vertex SDKs let a caller add an extra
 * header, so the two credentials never contend for the same slot: ours
 * identifies the run, theirs is discarded and replaced by the gateway with a
 * token minted from the customer's own service account.
 */
export const BYOK_TOKEN_HEADER = 'x-byok-token';

/** Told to the caller when the customer's credential was declined, so a client
 *  that has to interpret the failure can tell "your key is dead" from "the
 *  vendor is down". */
export const BYOK_DECLINED_HEADER = 'x-byok-declined';

/** Which key served the response, so a caller can log it without guessing. */
export const BYOK_SERVED_BY_HEADER = 'x-byok-served-by';
