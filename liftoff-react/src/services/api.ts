// Authenticated API client
// Automatically attaches Firebase ID token to all requests

import { auth } from '../config/firebase'
import { signOut as firebaseSignOut } from 'firebase/auth'
import { delegationHeader } from '../lib/supportDelegation'

// Custom error class that includes HTTP status and the backend's machine-readable
// error code. The code matters: callers branch on it to tell one 400 from another
// (NICKNAME_CONFLICT vs ALREADY_DECIDED vs anything else) and the message
// alone is prose that can be reworded server-side at any time.
export class ApiError extends Error {
  status: number
  /** The server's per-field rejection list, when it sent one.
   *
   *  A validation failure arrives as `{ error: 'Validation failed', details: [
   *  { path, code, message } ] }`, and dropping `details` on the floor meant the
   *  only thing any caller could know was that something was invalid. That is how
   *  a create rejected on `workflowSteps[1].description` reached a person as a
   *  bare "Validation failed" with nothing recorded anywhere.
   *
   *  Deliberately NOT for display — raw zod paths are not user-facing copy. It
   *  exists so callers can name the field in telemetry and so a support
   *  conversation has something to go on. */
  details?: unknown
  /** Top-level `code` from the JSON error body, when the endpoint sends one.
   *
   *  Distinct from the per-issue `code` inside `details`: this one names the
   *  rejection as a whole (NICKNAME_CONFLICT, ALREADY_DECIDED) so a
   *  caller can tell one 400 from another. The message alone is prose the server
   *  can reword at any time. Fourth positional on purpose — `details` shipped
   *  third and its callers are already pinned to that shape. */
  code?: string

  constructor(message: string, status: number, details?: unknown, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    if (details !== undefined) this.details = details
    this.code = code
  }
}

/** First field path from an ApiError's validation details, for telemetry.
 *
 *  Returns undefined for any error that is not a per-field rejection, which is
 *  most of them. */
export function firstInvalidField(error: unknown): string | undefined {
  const details = error instanceof ApiError ? error.details : undefined
  if (!Array.isArray(details)) return undefined
  for (const detail of details) {
    const path = (detail as { path?: unknown } | null)?.path
    if (typeof path === 'string' && path.length > 0) return path
    // zod's own issue shape carries path as an array of segments.
    if (Array.isArray(path) && path.length > 0) return path.join('.')
  }
  return undefined
}

/** Read a `code` off a thrown value without assuming it is an ApiError — mutation
 *  callbacks receive `unknown`, and a network failure throws a plain Error. */
export function apiErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined
}

// When MSW is active in dev, use same-origin so the service worker can intercept requests.
// Cross-origin requests (e.g. to api.example.com) bypass the service worker entirely.
const MSW_DISABLED =
  typeof import.meta.env.VITE_DISABLE_MSW === 'string' &&
  import.meta.env.VITE_DISABLE_MSW.toLowerCase() === 'true'

export const API_BASE_URL =
  import.meta.env.DEV && !MSW_DISABLED
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  // auth.currentUser is null until Firebase restores the persisted session.
  // authStateReady() resolves on the first auth state determination so we
  // don't race page-load queries against Firebase initialisation.
  await auth.authStateReady()
  const user = auth.currentUser
  if (!user) {
    return {}
  }

  const token = await user.getIdToken()
  return {
    Authorization: `Bearer ${token}`,
    // Present only in a tab running a support delegation session, where it
    // tells the backend to answer as the customer rather than as the signed-in
    // operator. The Authorization header above never changes: the operator's
    // credential is not swapped, only the identity the answer is about.
    ...delegationHeader(),
  }
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const authHeaders = await getAuthHeaders()

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options.headers,
    },
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }))
    const message = errorBody.message
      || errorBody.issue
      || (typeof errorBody.error === 'string' ? errorBody.error : null)
      || `HTTP ${response.status}`

    // If the server rejected our Firebase token (revoked or expired beyond
    // refresh), sign out so the AuthContext listener drops `user` to null
    // and ProtectedRoute redirects to /login. Covers the "other tab/device"
    // case after POST /api/accounts/me/sessions/revoke-all from another
    // session. Skip when no user is logged in (avoids redundant sign-outs).
    if (response.status === 401 && auth.currentUser) {
      void firebaseSignOut(auth)
    }

    throw new ApiError(
      message,
      response.status,
      errorBody.details ?? errorBody.issues,
      typeof errorBody.code === 'string' ? errorBody.code : undefined,
    )
  }

  // Handle 204 No Content (e.g., DELETE responses)
  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

/** The filename a Content-Disposition names: `filename*` (RFC 5987, UTF-8)
 *  first, then the plain `filename`, else null. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header)
  if (plain) {
    const value = (plain[1] ?? plain[2] ?? '').trim()
    return value.length > 0 ? value : null
  }
  return null
}

/**
 * An authenticated GET whose answer is a file.
 *
 * Beside apiFetch rather than a copy of the payroll fetchBlob, which skips
 * everything below: the same auth headers (so authStateReady, the delegation
 * header and the 401 sign-out all apply), an error body parsed the same way
 * into the same ApiError, and the filename read off Content-Disposition
 * (`filename*` first, then `filename`), which the backend exposes through CORS.
 */
export async function apiBlob(endpoint: string): Promise<{ blob: Blob; filename: string | null }> {
  const authHeaders = await getAuthHeaders()

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'GET',
    headers: { ...authHeaders },
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }))
    const message = errorBody.message
      || errorBody.issue
      || (typeof errorBody.error === 'string' ? errorBody.error : null)
      || `HTTP ${response.status}`

    if (response.status === 401 && auth.currentUser) {
      void firebaseSignOut(auth)
    }

    throw new ApiError(
      message,
      response.status,
      errorBody.details ?? errorBody.issues,
      typeof errorBody.code === 'string' ? errorBody.code : undefined,
    )
  }

  return {
    blob: await response.blob(),
    filename: filenameFromContentDisposition(response.headers.get('Content-Disposition')),
  }
}

// Convenience methods
export const api = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    apiFetch<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, data?: unknown, options?: RequestOptions) =>
    apiFetch<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, data?: unknown, options?: RequestOptions) =>
    apiFetch<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T>(endpoint: string, data?: unknown, options?: RequestOptions) =>
    apiFetch<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    apiFetch<T>(endpoint, { ...options, method: 'DELETE' }),
}

// Public API fetch (no auth required) - for pre-login endpoints
export async function publicFetch<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }));
    const message = errorBody.message
      || errorBody.issue
      || (typeof errorBody.error === 'string' ? errorBody.error : null)
      || `HTTP ${response.status}`
    throw new ApiError(
      message,
      response.status,
      errorBody.details ?? errorBody.issues,
      typeof errorBody.code === 'string' ? errorBody.code : undefined,
    );
  }

  return response.json();
}

// Email existence check for login flow
export async function checkEmailExists(email: string): Promise<{ exists: boolean }> {
  return publicFetch('/api/accounts/email-check', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}
