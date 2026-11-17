// WebAuthn Passkey Service
// Handles passkey registration and authentication via backend API

import { api } from './api'

export interface StoredPasskey {
  id: string
  credentialId: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
}

interface RegistrationOptions {
  challenge: string
  rp: {
    name: string
    id: string
  }
  user: {
    id: string
    name: string
    displayName: string
  }
  pubKeyCredParams: Array<{ alg: number; type: 'public-key' }>
  authenticatorSelection: {
    authenticatorAttachment: 'platform' | 'cross-platform'
    userVerification: 'required' | 'preferred' | 'discouraged'
    residentKey: 'required' | 'preferred' | 'discouraged'
  }
  timeout: number
  attestation: 'none' | 'indirect' | 'direct'
  excludeCredentials: Array<{ id: string; type: 'public-key' }>
}

interface AuthenticationOptions {
  challenge: string
  rpId: string
  allowCredentials: Array<{ id: string; type: 'public-key' }>
  userVerification: 'required' | 'preferred' | 'discouraged'
  timeout: number
}

// Check if WebAuthn is supported
export function isPasskeySupported(): boolean {
  return !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential === 'function'
  )
}

// Check if platform authenticator (Touch ID, Face ID, Windows Hello) is available
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isPasskeySupported()) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

// Convert base64url string to ArrayBuffer
function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(base64 + padding)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

// Convert ArrayBuffer to base64url string
function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let str = ''
  for (const byte of bytes) {
    str += String.fromCharCode(byte)
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// Get stored passkeys for current user from backend
export async function getStoredPasskeys(): Promise<StoredPasskey[]> {
  try {
    return await api.get<StoredPasskey[]>('/api/passkeys')
  } catch {
    return []
  }
}

// Remove passkey for current user via backend
export async function removePasskey(passkeyId: string): Promise<void> {
  await api.delete(`/api/passkeys/${passkeyId}`)
}

// Register a new passkey for the current user
export async function registerPasskey(): Promise<StoredPasskey> {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported on this device')
  }

  // Get registration options from backend
  const options = await api.post<RegistrationOptions>('/api/passkeys/register/options')

  // Convert base64url strings to ArrayBuffers for WebAuthn
  const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
    challenge: base64urlToBuffer(options.challenge) as BufferSource,
    rp: options.rp,
    user: {
      id: base64urlToBuffer(options.user.id) as BufferSource,
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    authenticatorSelection: options.authenticatorSelection,
    timeout: options.timeout,
    attestation: options.attestation,
    excludeCredentials: options.excludeCredentials.map((cred) => ({
      id: base64urlToBuffer(cred.id) as BufferSource,
      type: cred.type,
    })),
  }

  // Create credential using WebAuthn
  const credential = (await navigator.credentials.create({
    publicKey: publicKeyCredentialCreationOptions,
  })) as PublicKeyCredential

  if (!credential) {
    throw new Error('Failed to create passkey')
  }

  const response = credential.response as AuthenticatorAttestationResponse

  // Get transports if available (not supported in older iOS Safari)
  let transports: string[] = []
  try {
    if (typeof response.getTransports === 'function') {
      transports = response.getTransports()
    }
  } catch {
    // getTransports not available on this browser
  }

  // Send raw WebAuthn response to backend for verification
  // The server extracts the public key from attestationObject (best practice)
  // This works on all browsers including older iOS Safari
  const passkey = await api.post<StoredPasskey>('/api/passkeys/register/verify', {
    credentialId: bufferToBase64url(credential.rawId),
    attestationObject: bufferToBase64url(response.attestationObject),
    clientDataJSON: bufferToBase64url(response.clientDataJSON),
    transports,
    deviceName: getPasskeyName(),
  })

  return passkey
}

// Get a friendly name for the passkey based on the device
function getPasskeyName(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Passkey'
}

// Authenticate with a passkey
export async function authenticateWithPasskey(
  userId?: string
): Promise<{ userId: string; passkeyId: string; verified: boolean; customToken: string }> {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported on this device')
  }

  // Get authentication options from backend
  const options = await api.post<AuthenticationOptions>(
    '/api/passkeys/authenticate/options',
    { userId }
  )

  // Convert base64url strings to ArrayBuffers for WebAuthn
  const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
    challenge: base64urlToBuffer(options.challenge) as BufferSource,
    rpId: options.rpId,
    allowCredentials: (options.allowCredentials || []).map((cred) => ({
      id: base64urlToBuffer(cred.id) as BufferSource,
      type: cred.type,
    })),
    userVerification: options.userVerification,
    timeout: options.timeout,
  }

  // Get credential using WebAuthn
  const credential = (await navigator.credentials.get({
    publicKey: publicKeyCredentialRequestOptions,
  })) as PublicKeyCredential

  if (!credential) {
    throw new Error('Failed to authenticate with passkey')
  }

  const response = credential.response as AuthenticatorAssertionResponse

  // Verify authentication with backend
  const result = await api.post<{
    userId: string
    passkeyId: string
    verified: boolean
    customToken: string
  }>('/api/passkeys/authenticate/verify', {
    credentialId: bufferToBase64url(credential.rawId),
    counter: response.authenticatorData
      ? new DataView(response.authenticatorData).getUint32(33, false)
      : 0,
  })

  return result
}

// Check if user has any passkeys registered
export async function hasPasskeys(): Promise<boolean> {
  const passkeys = await getStoredPasskeys()
  return passkeys.length > 0
}

// Check if conditional UI (autofill) is available
export async function isConditionalUIAvailable(): Promise<boolean> {
  if (!isPasskeySupported()) return false
  try {
    return await PublicKeyCredential.isConditionalMediationAvailable?.() ?? false
  } catch {
    return false
  }
}

// Start conditional (autofill) passkey authentication
// This should be called when the login page loads
export async function startConditionalAuthentication(
  onSuccess: (result: { userId: string; passkeyId: string; verified: boolean; customToken: string }) => void,
  onError?: (error: Error) => void
): Promise<AbortController | null> {
  if (!await isConditionalUIAvailable()) {
    return null
  }

  const abortController = new AbortController()

  try {
    // Get authentication options from backend (without specific user)
    const options = await api.post<AuthenticationOptions>(
      '/api/passkeys/authenticate/options',
      { conditional: true }
    )

    // Convert base64url strings to ArrayBuffers for WebAuthn
    const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
      challenge: base64urlToBuffer(options.challenge) as BufferSource,
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials || []).map((cred) => ({
        id: base64urlToBuffer(cred.id) as BufferSource,
        type: cred.type,
      })),
      userVerification: options.userVerification,
      timeout: options.timeout,
    }

    // Start conditional authentication (this will show in autofill)
    const credential = (await navigator.credentials.get({
      publicKey: publicKeyCredentialRequestOptions,
      mediation: 'conditional',
      signal: abortController.signal,
    })) as PublicKeyCredential

    if (!credential) {
      throw new Error('Failed to authenticate with passkey')
    }

    const response = credential.response as AuthenticatorAssertionResponse

    // Verify authentication with backend
    const result = await api.post<{
      userId: string
      passkeyId: string
      verified: boolean
      customToken: string
    }>('/api/passkeys/authenticate/verify', {
      credentialId: bufferToBase64url(credential.rawId),
      counter: response.authenticatorData
        ? new DataView(response.authenticatorData).getUint32(33, false)
        : 0,
    })

    onSuccess(result)
  } catch (error) {
    // Ignore abort errors (page navigation, etc.)
    if (error instanceof Error && error.name === 'AbortError') {
      return abortController
    }
    onError?.(error instanceof Error ? error : new Error('Passkey authentication failed'))
  }

  return abortController
}
