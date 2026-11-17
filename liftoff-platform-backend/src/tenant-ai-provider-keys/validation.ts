// One live call per submitted credential, before anything is stored.
//
// The contract is that nothing unverified is ever persisted, which is what
// removes `unverified` from the status enum. Two failure kinds, kept distinct
// because they mean different things to the person at the card:
//
//   invalid_key — the provider answered, and said no. The credential is wrong.
//   unreachable — we could not get an answer. It may be perfect.
//
// Both reject the write. A provider outage is a rejection, never a silent store
// of something unchecked: storing it would put a credential we have never seen
// work behind a `valid` badge, and the first thing that discovers otherwise is a
// customer's agent failing mid-turn.
//
// The probe is the cheapest authenticated call each provider offers. For the
// three key-issuing vendors that is a model list; for Google it is a token
// exchange followed by `countTokens`, which is free, touches no customer data,
// and — unlike a bare token exchange — proves the service account can actually
// reach Vertex in the project and location the customer named. A key that
// authenticates but has no `aiplatform.user` role would otherwise be stored as
// valid and fail on the first real turn.

import { mintVertexAccessToken, vertexHostForLocation } from '../byok-gateway/vertex-token';
import type {
  AiProviderKeyVendor,
  ApiKeyVendor,
  StoredCredential,
  VertexServiceAccountCredential,
} from './types';

export type KeyValidationFailure = 'invalid_key' | 'unreachable';

export type KeyValidationResult =
  | { ok: true }
  | { ok: false; code: KeyValidationFailure; message: string };

/** Human name for the message the card shows beside the field. */
const VENDOR_LABEL: Record<AiProviderKeyVendor, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  xai: 'xAI',
};

/** How long to wait for a provider before calling it unreachable. Long enough
 *  that a cold provider edge is not mistaken for an outage, short enough that a
 *  save cannot hang the settings card. */
const PROBE_TIMEOUT_MS = 10_000;

/** A model that exists in every Vertex project with the Gemini API enabled, used
 *  only as the subject of a token count. Nothing is generated and nothing is
 *  billed. */
const VERTEX_PROBE_MODEL = 'gemini-2.5-flash';

interface Probe {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
}

/** The authenticated read used to check each key-issuing vendor. */
const PROBES: Record<ApiKeyVendor, Probe> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  },
  xai: {
    url: 'https://api.x.ai/v1/models',
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  },
};

/** Verify one credential against its provider. */
export async function validateProviderCredential(
  vendor: AiProviderKeyVendor,
  credential: StoredCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidationResult> {
  if (credential.kind === 'vertex_service_account') {
    return validateVertexServiceAccount(credential, fetchImpl);
  }
  return validateApiKey(vendor as ApiKeyVendor, credential.apiKey, fetchImpl);
}

async function validateApiKey(
  vendor: ApiKeyVendor,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<KeyValidationResult> {
  const probe = PROBES[vendor];
  const label = VENDOR_LABEL[vendor];

  const response = await probeWithTimeout(
    () => fetchImpl(probe.url, { method: 'GET', headers: probe.headers(apiKey) }),
  );
  if (response === 'unreachable') {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${label} to verify this key. Try again in a moment.`,
    };
  }
  return classifyProbeStatus(response, label, 'key');
}

async function validateVertexServiceAccount(
  credential: VertexServiceAccountCredential,
  fetchImpl: typeof fetch,
): Promise<KeyValidationResult> {
  const label = VENDOR_LABEL.google;

  // Step one: exchange the key pair for an access token. A deleted key, a
  // disabled service account or a malformed PEM all fail HERE, before any
  // request reaches Vertex — and they are unambiguously the credential's fault,
  // never an outage, so they are reported as such.
  let token: string;
  try {
    token = await mintVertexAccessToken(credential);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_key',
      message:
        `${label} did not accept this service account: ${(error as Error).message}`,
    };
  }

  // Step two: prove it can actually reach Vertex in the project and location
  // the customer named. The token proves WHO the service account is; this
  // proves it has been granted something. A service account with no
  // `aiplatform.user` role mints a perfectly good token and then 403s on the
  // first real turn.
  const host = vertexHostForLocation(credential.location);
  const url =
    `https://${host}/v1/projects/${encodeURIComponent(credential.project)}`
    + `/locations/${encodeURIComponent(credential.location)}`
    + `/publishers/google/models/${VERTEX_PROBE_MODEL}:countTokens`;

  const response = await probeWithTimeout(() =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
    }),
  );
  if (response === 'unreachable') {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${label} to verify this service account. Try again in a moment.`,
    };
  }
  return classifyProbeStatus(response, label, 'service account');
}

/** Run a probe under the shared timeout. Returns the sentinel rather than
 *  throwing, so both callers classify the outcome the same way. */
async function probeWithTimeout(
  send: () => Promise<Response>,
): Promise<Response | 'unreachable'> {
  const timeout = new Promise<'unreachable'>((resolve) =>
    setTimeout(() => resolve('unreachable'), PROBE_TIMEOUT_MS),
  );
  try {
    return await Promise.race([send(), timeout]);
  } catch {
    return 'unreachable';
  }
}

function classifyProbeStatus(
  response: Response,
  label: string,
  noun: string,
): KeyValidationResult {
  if (response.ok) return { ok: true };

  // 401 and 403 are the provider telling us the credential is not honoured.
  // 429 is a live account being rate limited, which proves it works — the
  // provider had to authenticate it to know whose quota to charge. Everything
  // else (5xx, a gateway page, an unexpected 4xx) is us not getting an answer.
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'invalid_key', message: `${label} did not accept this ${noun}.` };
  }
  if (response.status === 429) return { ok: true };

  return {
    ok: false,
    code: 'unreachable',
    message: `Could not reach ${label} to verify this ${noun} (HTTP ${response.status}).`,
  };
}
