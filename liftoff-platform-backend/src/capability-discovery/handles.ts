// Opaque capability handles for the model boundary.
//
// The model must never see the vendor behind a capability (a vendor name in a
// tool result can be spoken into a chat, and the Chief AI Officer absorbs that
// transcript when it builds an agent). So capability_search mints a handle per
// runnable candidate and returns ONLY the handle; run_capability resolves it
// back to the underlying `<connectorType>:<functionName>` ref. Vendor identity
// lives here and in the executor, never on the model boundary.
//
// STATELESS by design. The handle is an authenticated-encryption token that
// carries its own ref — there is no server-side store. This is what lets the
// SAME handle resolve on a different process than the one that minted it: the
// Liftoff assistant runs search+run in one tool-loop (one process), but a
// distilled agent (tenant-runtime) and the CAIO (workforce-service) call
// platform-backend over HTTP, so search and run can land on different
// instances. AES-256-GCM makes the token both opaque to the model (it cannot
// read the vendor out of it) and tamper-evident (a forged handle fails to
// decrypt and is rejected). The key is derived from a service secret already
// shared across every instance, so no new secret is provisioned.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';
import { actFamilyOf, canonicalActRef } from './act-family';

/** One alternative in a handle's tail: a reference the executor can run, and
 *  the server-set arguments it needs. A store actor rides here as
 *  `{ ref: 'apify:run_actor', presetArgs: { actorId } }` — the actor id is the
 *  source's identity and never crosses the model boundary, so it lives in the
 *  ciphertext with the reference. */
export interface CapabilityTailEntry {
  ref: string;
  presetArgs?: Record<string, unknown>;
}

interface CapabilityHandle {
  /** The candidate the model chose: '<connectorType>:<functionName>'. */
  primaryRef: string;
  /** Lower-ranked alternatives for the same need, in the order the chain
   *  tries them when the primary produced nothing. Read-class only, decided
   *  at mint time. */
  fallbacks: CapabilityTailEntry[];
  /** Server-set arguments the executor merges UNDER the model's own args, so
   *  they cannot be seen or overridden from the model boundary. Carries the
   *  identity that would otherwise leak the vendor — e.g. the Apify actor id
   *  for a `apify:run_actor` handle, which the model must never see. Absent for
   *  ordinary connector-function handles. */
  presetArgs?: Record<string, unknown>;
}

/** The tail as it is encoded: `{ r, a? }` per entry. A handle minted before
 *  entries carried arguments encoded each as a bare string; those still
 *  resolve for their TTL (see resolveCapabilityHandle). */
interface EncodedTailEntry {
  r: string;
  a?: Record<string, unknown>;
}

const HANDLE_PREFIX = 'cap_';
// A plaintext read/write class marker, right after the prefix, so a caller that
// CANNOT decrypt the handle (the tenant-runtime, which only forwards it) can
// still tell at admission time whether running this capability needs human
// approval — WITHOUT learning the vendor, which stays inside the ciphertext.
// The class is read/write only; it is not vendor-identifying, so exposing it
// leaks nothing the vendor-hiding contract protects.
//
// `.` separates the marker from the base64url body and is NOT in the base64url
// alphabet ([A-Za-z0-9_-]), so `cap_w.<body>` / `cap_r.<body>` parse
// unambiguously and an OLD unmarked `cap_<body>` (minted before this change,
// still resolvable during a deploy window) is told apart with no collision.
// The marker is only a HINT for the runtime's gate: platform-backend never
// trusts it, and re-derives the true class from the tool classification at
// execution — so a stripped or flipped marker can at worst cause a refusal or
// a redundant approval, never an unapproved write.
const MARK_APPROVAL = 'w.';
const MARK_READ = 'r.';
/** Length of the plaintext operation segment (hex). */
const OPERATION_LEN = 12;
const OPERATION_RE = /^[0-9a-f]{12}$/;
const TTL_MS = 30 * 60_000;
const IV_LEN = 12;
const TAG_LEN = 16;

/** 32-byte AES key derived (HKDF) from a stable, cross-instance service secret.
 *  A dedicated info string domain-separates it from the secret's other uses.
 *  The dev/test fallback keeps mint/resolve round-tripping when no secret is
 *  configured; it is per-process, which is fine because that only happens where
 *  there is a single process (tests, local). */
export function deriveHandleKey(info: string): Buffer {
  const secret =
    process.env.CONNECTOR_SERVICE_TOKEN ||
    process.env.TENANT_RUNTIME_SERVICE_TOKEN ||
    'dev-capability-handle-fallback';
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.from('liftoff.capability-handle.salt.v1'), info, 32),
  );
}

const KEY: Buffer = deriveHandleKey('capability-handle-v1');

/** Whether a reference names something the executor can run: a
 *  `<connectorType>:<functionName>` pair. A connector-level reference names a
 *  system, not an action, and the executor skips it. */
/**
 * The operation a reference names, as a fingerprint that names no vendor.
 *
 * The runtime needs to tell two capabilities apart — and recognise one
 * capability across two searches — WITHOUT learning what either resolves to.
 * The handle body is encrypted and stays that way; this is a keyed digest of
 * the resolved reference, carried in the clear beside it. Keyed, so a reader
 * of a ledger row cannot recover the vendor by hashing a short list of
 * candidates. Canonicalised the way the runtime spells a connector type, so
 * `google_mail:send_email` and `google-mail:Send_Email` are one operation.
 */
export function operationFingerprint(ref: string): string {
  return createHmac('sha256', KEY).update(canonicalActRef(ref)).digest('hex').slice(0, OPERATION_LEN);
}

const FAMILY_RE = /^[a-z_]{1,32}$/;

export function isExecutableRef(ref: string): boolean {
  const i = ref.indexOf(':');
  return i > 0 && i < ref.length - 1;
}

function hasPresetArgs(a: Record<string, unknown> | undefined): a is Record<string, unknown> {
  return !!a && Object.keys(a).length > 0;
}

export function mintCapabilityHandle(
  primaryRef: string,
  /** The tail, as entries or — for a caller with only references — bare
   *  strings. Every entry's reference must name a function; the rest are
   *  dropped for the reason the primary is refused. */
  fallbacks: Array<CapabilityTailEntry | string> = [],
  presetArgs?: Record<string, unknown>,
  /** True when running this capability is a write/outbound-class action that
   *  must pass human approval. Encoded as a plaintext class marker so the
   *  runtime's admission gate can pause on it without decrypting the handle. */
  requiresApproval = false,
): string {
  // A handle promises the model something it can run. A primary reference
  // with no function cannot be run, so it is refused here — at discovery,
  // where the caller can leave the candidate out — rather than minted and
  // skipped silently at execution. Fallbacks without a function are dropped
  // for the same reason.
  if (!isExecutableRef(primaryRef)) {
    throw new Error(`capability reference "${primaryRef}" names no function and cannot be minted`);
  }
  const tail: EncodedTailEntry[] = fallbacks
    .map((f): CapabilityTailEntry => (typeof f === 'string' ? { ref: f } : f))
    .filter((f) => isExecutableRef(f.ref))
    .map((f) => ({ r: f.ref, ...(hasPresetArgs(f.presetArgs) ? { a: f.presetArgs } : {}) }));
  const payload = JSON.stringify({
    p: primaryRef,
    f: tail,
    e: Date.now() + TTL_MS,
    ...(hasPresetArgs(presetArgs) ? { a: presetArgs } : {}),
  });
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const marker = requiresApproval ? MARK_APPROVAL : MARK_READ;
  // `cap_<w|r>.<operation>[.<family>].<ciphertext>` — base64url carries no
  // '.', so the segments are unambiguous. The runtime reads the operation and
  // the family by this format alone, without the key, the way it reads the
  // class marker. The family is present only for a reference that has one.
  const family = actFamilyOf(primaryRef);
  return HANDLE_PREFIX + marker + operationFingerprint(primaryRef) + '.'
    + (family ? `${family}.` : '')
    + Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function resolveCapabilityHandle(token: string): CapabilityHandle | null {
  if (typeof token !== 'string' || !token.startsWith(HANDLE_PREFIX)) return null;
  try {
    // Strip the optional plaintext class marker (`w.` / `r.`) before decoding
    // the base64url body. An unmarked legacy handle has neither and decodes
    // whole. The marker never enters the ciphertext, so the true class is the
    // classification's to decide, not the token's.
    let body = token.slice(HANDLE_PREFIX.length);
    if (body.startsWith(MARK_APPROVAL) || body.startsWith(MARK_READ)) {
      body = body.slice(MARK_APPROVAL.length);
    }
    // The operation segment is bound to the ciphertext below: it is recomputed
    // from the decrypted reference and a mismatch refuses the handle, so the
    // clear-text half cannot be edited to relabel an operation. A handle with
    // no segment predates it and is accepted for its remaining TTL.
    let statedOperation: string | null = null;
    let statedFamily: string | null = null;
    const segments = body.split('.');
    if (segments.length === 2) {
      [statedOperation, body] = segments;
    } else if (segments.length === 3) {
      [statedOperation, statedFamily, body] = segments;
      if (!FAMILY_RE.test(statedFamily)) return null;
    } else if (segments.length !== 1) {
      return null;
    }
    if (statedOperation !== null && !OPERATION_RE.test(statedOperation)) return null;
    const raw = Buffer.from(body, 'base64url');
    if (raw.length <= IV_LEN + TAG_LEN) return null;
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext) as { p?: unknown; f?: unknown; e?: unknown; a?: unknown };
    if (typeof payload.e !== 'number' || payload.e < Date.now()) return null;
    if (typeof payload.p !== 'string' || !payload.p) return null;
    if (statedOperation !== null) {
      if (statedOperation !== operationFingerprint(payload.p)) return null;
      // The family is bound the same way: a new-format handle states exactly
      // the family its reference has, or none, and a relabelled one does not
      // resolve.
      if (statedFamily !== actFamilyOf(payload.p)) return null;
    }
    return {
      primaryRef: payload.p,
      fallbacks: decodeTail(payload.f),
      ...(isPlainObject(payload.a) ? { presetArgs: payload.a } : {}),
    };
  } catch {
    // Tampered, truncated, expired-key, or wrong-key token — refuse it.
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The tail, whichever way it was encoded. A bare string is a handle from
 *  before entries carried arguments — `{ r }` with nothing else — and stays
 *  readable across the deploy for the thirty-minute TTL. An entry that names
 *  no function is dropped, as at mint. */
function decodeTail(f: unknown): CapabilityTailEntry[] {
  if (!Array.isArray(f)) return [];
  const out: CapabilityTailEntry[] = [];
  for (const entry of f) {
    if (typeof entry === 'string') {
      if (isExecutableRef(entry)) out.push({ ref: entry });
      continue;
    }
    if (!isPlainObject(entry) || typeof entry.r !== 'string' || !isExecutableRef(entry.r)) continue;
    out.push({ ref: entry.r, ...(isPlainObject(entry.a) ? { presetArgs: entry.a } : {}) });
  }
  return out;
}

/** Retained as a no-op so existing callers/tests need no change now that
 *  handles are stateless (there is no store to clear). */
export function _clearCapabilityHandles(): void {
  /* stateless: nothing to clear */
}
