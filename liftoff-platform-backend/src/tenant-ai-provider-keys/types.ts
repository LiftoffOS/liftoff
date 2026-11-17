// The wire contract for the AI provider keys card on Settings → Workspace.
//
// Mirrors Liftoff-React's src/services/aiProviderKeys.ts field for field. The
// client is already written against these names, so a rename here is a broken
// card, not a refactor.

/** The account a key belongs to.
 *
 *  `xai`, not the `grok` used by WORKSPACE_AI_VENDORS. That list names the
 *  model brand a workspace routes to, and Grok reaches us through OpenRouter;
 *  this one names the account the key pays from. A customer's xAI key cannot
 *  settle an OpenRouter invoice, which is precisely why the two vocabularies
 *  stay separate. */
export type AiProviderKeyVendor = 'anthropic' | 'google' | 'openai' | 'xai';

/** Display order is the order the card offers the providers in. */
export const AI_PROVIDER_KEY_VENDORS: readonly AiProviderKeyVendor[] = [
  'anthropic',
  'google',
  'openai',
  'xai',
] as const;

export function isAiProviderKeyVendor(v: unknown): v is AiProviderKeyVendor {
  return typeof v === 'string' && (AI_PROVIDER_KEY_VENDORS as readonly string[]).includes(v);
}

/**
 * Whether the stored key still works.
 *
 * There is deliberately no 'unverified'. A key is checked against its provider
 * on the way in and a write that fails is rejected outright, so nothing
 * unchecked is ever stored. 'revoked' is therefore never written by the save
 * path: it is what a key that WAS valid decays into once someone revokes it at
 * the provider, it expires, or the account hits a spend cap. That signal
 * reaches us from a runtime 401.
 */
export type AiProviderKeyStatus = 'valid' | 'revoked';

export interface AiProviderKey {
  vendor: AiProviderKeyVendor;
  /** Partial redaction of the stored key, e.g. "sk-ant••••••••3f2x". The card
   *  puts this straight into the field when it is reopened, so it has to be
   *  recognisable as the key the user saved without being usable as one. */
  hint: string | null;
  status: AiProviderKeyStatus;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
}

/** Write payload. A vendor absent from the map keeps whatever is stored. */
/**
 * A write. Three states per vendor, and the difference between the last two is
 * the whole reason this is not `Record<vendor, string>`:
 *
 *   absent  keep whatever is stored (the merge that stops a rotation of one key
 *           dropping the other three)
 *   string  store this key, replacing any current one
 *   null    REMOVE the stored key: the row goes, the Secret Manager secret is
 *           destroyed, and the workspace falls back to Liftoff's managed pool
 *           for that provider
 *
 * An empty string is deliberately NOT a removal. A field the user focused and
 * left submits nothing, and treating that as "delete my key" would make a stray
 * click destructive. Removal is only ever the explicit null the clear button
 * sends.
 */
export type AiProviderKeyUpdate = Partial<Record<AiProviderKeyVendor, string | null>>;

/** The literal bullet the redaction uses. U+2022, matching the client's mask —
 *  a different bullet would still render but would not compare equal in the
 *  client tests that pin the exact string. */
const MASK_BULLET = '•';

/** Fixed-width interior, so the hint never discloses how long the key was. */
const MASK_WIDTH = 8;

/** Leading characters that survive: the vendor's own prefix, identical across
 *  every key that vendor issues, so it gives nothing away. */
const HEAD_LENGTH = 6;

/** Trailing characters that survive: enough to tell one of the customer's own
 *  keys from another, and no more. */
const TAIL_LENGTH = 4;

/**
 * The redaction a read returns. Reference implementation is `maskApiKey` in
 * Liftoff-React's src/services/aiProviderKeys.ts and this must produce the
 * identical string: the client's own tests pin `sk-ant••••••••3f2x` for a key
 * ending `3f2x`, and the card renders whatever we send verbatim.
 *
 * Returns null for anything too short to redact well — below the threshold the
 * head and tail would overlap and hand back most of the string. The shortest of
 * the four vendors' key formats is comfortably past this.
 */
export function maskApiKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length < 12) return null;
  return `${trimmed.slice(0, HEAD_LENGTH)}${MASK_BULLET.repeat(MASK_WIDTH)}${trimmed.slice(-TAIL_LENGTH)}`;
}

/**
 * True when a submitted value is one of our own hints coming back.
 *
 * The card is built so this cannot happen — a field still displaying its
 * redaction is untouched and submits nothing — but the contract asks the
 * endpoint to reject one rather than store it, because storing a hint as a key
 * silently destroys the real credential and the customer has no way to tell.
 */
export function looksLikeHint(value: string): boolean {
  return value.includes(MASK_BULLET);
}

// ── What a stored credential actually is ────────────────────────────────────
//
// Three of the four vendors issue an opaque bearer string. Google does not:
// a customer's Google AI capacity lives in their own Vertex AI project, and the
// credential for it is a SERVICE ACCOUNT — a project, a location, and an
// asymmetric key pair. There is no API key to paste.
//
// That difference is not cosmetic and it is why this is a union rather than a
// string. A service account is not sent as a credential at all: it is EXCHANGED
// for a short-lived OAuth access token, which is what goes on the wire. The key
// itself stays in Secret Manager and is re-exchanged on demand, which is what
// makes access perpetual — the hour-long token expires, the service account
// behind it does not.

/** The vendors whose credential is a single opaque string. */
export type ApiKeyVendor = Exclude<AiProviderKeyVendor, 'google'>;

export interface ApiKeyCredential {
  kind: 'api_key';
  apiKey: string;
}

export interface VertexServiceAccountCredential {
  kind: 'vertex_service_account';
  /** The customer's own GCP project. Appears in every Vertex request path. */
  project: string;
  /** The customer's Vertex region. Selects the API host as well as the path. */
  location: string;
  clientEmail: string;
  /** PEM. The only genuinely secret half; never leaves the control plane. */
  privateKey: string;
}

export type StoredCredential = ApiKeyCredential | VertexServiceAccountCredential;

/**
 * Where Vertex serves a model when the customer did not say.
 *
 * `global` is Vertex's meta-endpoint: it routes to wherever the requested model
 * is actually served, and it is the only location that serves every current
 * Gemini model in this estate — regional endpoints 404 for several of them. A
 * customer who needs a specific region says so by pasting the object form with
 * an explicit `location`.
 */
export const DEFAULT_VERTEX_LOCATION = 'global';

export type CredentialParse =
  | { ok: true; credential: StoredCredential; hint: string }
  | { ok: false; message: string };

/**
 * Turn what the customer pasted into a credential, or say why it is not one.
 *
 * Runs before any network call, because two of the rejections here are cheap
 * and certain: a redaction pasted back would destroy the real credential, and a
 * string too short to be any vendor's key is not worth a round trip.
 */
export function parseSubmittedCredential(
  vendor: AiProviderKeyVendor,
  raw: string,
): CredentialParse {
  const trimmed = raw.trim();

  if (looksLikeHint(trimmed)) {
    return { ok: false, message: 'That is the redaction of the saved key, not a key. Paste a new one.' };
  }

  if (vendor === 'google') return parseVertexServiceAccount(trimmed);

  const hint = maskApiKey(trimmed);
  if (!hint) return { ok: false, message: 'That does not look like a complete API key.' };
  return { ok: true, credential: { kind: 'api_key', apiKey: trimmed }, hint };
}

/** A service-account JSON as Google hands it to you, downloaded from the IAM
 *  console. The three fields we need are `project_id`, `client_email` and
 *  `private_key`; everything else in the file is ignored. */
interface GoogleServiceAccountFile {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
  location?: string;
}

/** The shape the platform states internally, accepted verbatim so a caller that
 *  already holds it does not have to reassemble a file to submit one. */
interface VertexCredentialObject {
  project?: string;
  location?: string;
  googleCredentials?: { privateKey?: string; clientEmail?: string };
}

/**
 * Accept either form a person would plausibly paste.
 *
 * The downloaded service-account file is what a customer actually has in hand,
 * so refusing it and demanding a hand-built object would be an obstacle with no
 * purpose. The explicit object is accepted too because it is the only way to
 * name a location, which the file does not carry.
 */
function parseVertexServiceAccount(raw: string): CredentialParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message:
        'Google needs a Vertex AI service account, not an API key. Paste the JSON key file '
        + 'you downloaded from Google Cloud.',
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, message: 'That is not a Vertex AI service account.' };
  }

  const file = parsed as GoogleServiceAccountFile & VertexCredentialObject;
  const project = (file.project ?? file.project_id ?? '').trim();
  const clientEmail = (file.googleCredentials?.clientEmail ?? file.client_email ?? '').trim();
  const privateKey = file.googleCredentials?.privateKey ?? file.private_key ?? '';
  const location = (file.location ?? DEFAULT_VERTEX_LOCATION).trim();

  const missing: string[] = [];
  if (!project) missing.push('project');
  if (!clientEmail) missing.push('client email');
  if (!privateKey) missing.push('private key');
  if (missing.length > 0) {
    return {
      ok: false,
      message: `That service account is missing its ${missing.join(', ')}.`,
    };
  }

  // A PEM block, not a bearer string. Checked here because the alternative is
  // discovering it when the token exchange fails with an opaque OpenSSL error.
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    return {
      ok: false,
      message: 'That private key is not in PEM form. Paste the JSON key file unmodified.',
    };
  }

  return {
    ok: true,
    credential: {
      kind: 'vertex_service_account',
      project,
      location,
      clientEmail,
      // A JSON key file carries the PEM with escaped newlines when it has been
      // through a copy-paste that re-encoded it. Restoring them here is the
      // difference between a working key and an unreadable one, and the failure
      // it prevents surfaces as an OpenSSL parse error nobody can act on.
      privateKey: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey,
    },
    // The service account's own address. It identifies WHICH credential is
    // stored — the job the hint exists to do — and discloses nothing: the email
    // is visible to anyone with read access to the customer's own IAM page, and
    // the secret half is the private key, which never leaves the server.
    hint: clientEmail,
  };
}
