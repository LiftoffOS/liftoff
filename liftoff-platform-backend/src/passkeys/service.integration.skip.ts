// src/passkeys/service.test.ts
import { PasskeyService } from './service'

// Create stable mock pool reference
const mockPoolQuery = jest.fn()
const mockPoolInstance = {
  query: mockPoolQuery,
}

// Mock database
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPoolInstance),
}))

// Mock logging
jest.mock('../infrastructure/logging', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

// Helper to convert Buffer to ArrayBuffer
function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.length)
  const view = new Uint8Array(arrayBuffer)
  for (let i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i]
  }
  return arrayBuffer
}

// Mock helper functions for creating test data
function createMockAuthenticatorData(options: {
  userPresent?: boolean
  userVerified?: boolean
  signCount?: number
  rpId?: string
} = {}) {
  const {
    userPresent = true,
    userVerified = false,
    signCount = 1,
    rpId = 'example.com',
  } = options

  // Build flags byte
  let flags = 0
  if (userPresent) flags |= 0x01
  if (userVerified) flags |= 0x04

  // Build authenticator data buffer
  const rpIdHash = Buffer.alloc(32) // SHA-256 placeholder
  const flagsByte = Buffer.from([flags])
  const signCountBuffer = Buffer.alloc(4)
  signCountBuffer.writeUInt32BE(signCount)

  const raw = Buffer.concat([rpIdHash, flagsByte, signCountBuffer])

  return {
    rpIdHash,
    flags,
    signCount,
    rpId,
    raw,
    rawArrayBuffer: bufferToArrayBuffer(raw),
  }
}

// Note: WebAuthn API uses ArrayBuffer, so we need proper ArrayBuffer objects
function createMockCredential(options: {
  id?: string
  challenge?: string
  authData?: ReturnType<typeof createMockAuthenticatorData>
  userHandle?: string
  invalidSignature?: boolean
} = {}): any {
  const {
    id = 'test-credential-id',
    challenge = 'test-challenge',
    authData = createMockAuthenticatorData(),
    userHandle = 'test-user',
    invalidSignature = false,
  } = options

  // The challenge in clientDataJSON should match what verifyAssertion expects
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: 'webauthn.get',
    challenge: challenge,  // Use plain challenge, not base64url encoded
    origin: 'https://example.com',
  }))

  const signature = invalidSignature ? Buffer.from('invalid') : Buffer.from('valid-signature')
  const userHandleBuffer = userHandle ? Buffer.from(userHandle) : null

  return {
    id,
    rawId: bufferToArrayBuffer(Buffer.from(id)),
    response: {
      authenticatorData: authData.rawArrayBuffer,
      clientDataJSON: bufferToArrayBuffer(clientDataJSON),
      signature: bufferToArrayBuffer(signature),
      userHandle: userHandleBuffer ? bufferToArrayBuffer(userHandleBuffer) : null,
    },
    type: 'public-key' as const,
    clientExtensionResults: {},
    authenticatorAttachment: 'platform' as const,
  }
}

describe('PasskeyService.verifyAssertion', () => {
  let service: PasskeyService

  beforeEach(() => {
    service = new PasskeyService()
    jest.useFakeTimers()
    mockPoolQuery.mockReset()
    // Default mock for finding credential - returns null (not found)
    mockPoolQuery.mockResolvedValue({ rows: [] })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('Challenge verification', () => {
    it('should reject when challenge does not match', async () => {
      // Create credential with one challenge, verify with another
      const credential = createMockCredential({ challenge: 'wrong-challenge' })
      await expect(
        service.verifyAssertion(credential, 'expected-challenge', 'https://example.com')
      ).rejects.toThrow('Challenge mismatch')
    })

    it('should reject expired challenges (>5 minutes old)', async () => {
      const expiredChallenge = await service.createChallenge()
      const credential = createMockCredential({ challenge: expiredChallenge.value })
      jest.advanceTimersByTime(6 * 60 * 1000) // 6 minutes
      await expect(
        service.verifyAssertion(credential, expiredChallenge.value, 'https://example.com')
      ).rejects.toThrow('Challenge expired')
    })
  })

  describe('User Presence (UP) flag validation', () => {
    const testChallenge = 'test-challenge'

    it('should reject when UP flag is not set', async () => {
      const authData = createMockAuthenticatorData({ userPresent: false })
      await expect(
        service.verifyAssertion(createMockCredential({ authData, challenge: testChallenge }), testChallenge, 'https://example.com')
      ).rejects.toThrow('User presence not verified')
    })

    it('should accept when UP flag is set', async () => {
      const authData = createMockAuthenticatorData({ userPresent: true })
      const result = await service.verifyAssertion(
        createMockCredential({ authData, challenge: testChallenge }), testChallenge, 'https://example.com'
      )
      expect(result.verified).toBe(true)
    })
  })

  describe('User Verification (UV) flag validation', () => {
    const testChallenge = 'test-challenge'

    it('should reject when UV is required but not set', async () => {
      const authData = createMockAuthenticatorData({ userVerified: false })
      await expect(
        service.verifyAssertion(
          createMockCredential({ authData, challenge: testChallenge }),
          testChallenge,
          'https://example.com',
          { requireUserVerification: true }
        )
      ).rejects.toThrow('User verification required but not performed')
    })
  })

  describe('Signature counter (replay attack prevention)', () => {
    const testChallenge = 'test-challenge'

    it('should reject when new counter <= stored counter (potential cloned authenticator)', async () => {
      // Mock: credential exists with counter 100
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'passkey-1',
          user_id: 'test-user',
          credential_id: 'credential-id',
          public_key: 'mock-public-key',
          counter: 100,
          device_name: null,
          transports: null,
          created_at: new Date(),
          last_used_at: null,
        }],
      })

      // Attempt to verify with counter = 50 (lower)
      const authData = createMockAuthenticatorData({ signCount: 50 })
      await expect(
        service.verifyAssertion(createMockCredential({ authData, id: 'credential-id', challenge: testChallenge }), testChallenge, 'https://example.com')
      ).rejects.toThrow('Signature counter invalid - possible replay attack')
    })

    it('should accept when counter = 0 (authenticators that dont support counters)', async () => {
      // Mock: credential exists with counter 100
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'passkey-1',
          user_id: 'test-user',
          credential_id: 'credential-id',
          public_key: 'mock-public-key',
          counter: 100,
          device_name: null,
          transports: null,
          created_at: new Date(),
          last_used_at: null,
        }],
      })

      const authData = createMockAuthenticatorData({ signCount: 0 })
      // Counter 0 is a special case - some authenticators always return 0
      const result = await service.verifyAssertion(
        createMockCredential({ authData, id: 'credential-id', challenge: testChallenge }), testChallenge, 'https://example.com'
      )
      expect(result.verified).toBe(true)
    })

    it('should accept and update counter when new counter > stored counter', async () => {
      // Mock: credential exists with counter 100
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'passkey-1',
            user_id: 'test-user',
            credential_id: 'credential-id',
            public_key: 'mock-public-key',
            counter: 100,
            device_name: null,
            transports: null,
            created_at: new Date(),
            last_used_at: null,
          }],
        })
        // For update counter query
        .mockResolvedValueOnce({
          rows: [{
            id: 'passkey-1',
            user_id: 'test-user',
            credential_id: 'credential-id',
            public_key: 'mock-public-key',
            counter: 101,
            device_name: null,
            transports: null,
            created_at: new Date(),
            last_used_at: new Date(),
          }],
        })

      const authData = createMockAuthenticatorData({ signCount: 101 })
      const result = await service.verifyAssertion(
        createMockCredential({ authData, id: 'credential-id', challenge: testChallenge }), testChallenge, 'https://example.com'
      )
      expect(result.verified).toBe(true)
    })
  })

  describe('UserHandle verification', () => {
    const testChallenge = 'test-challenge'

    it('should reject when userHandle does not match stored credential', async () => {
      // Mock: credential exists with userId 'user-123'
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'passkey-1',
          user_id: 'user-123',
          credential_id: 'credential-id',
          public_key: 'mock-public-key',
          counter: 0,
          device_name: null,
          transports: null,
          created_at: new Date(),
          last_used_at: null,
        }],
      })

      // Verify with different userHandle
      const credential = createMockCredential({
        id: 'credential-id',
        userHandle: 'different-user',
        challenge: testChallenge,
      })
      await expect(
        service.verifyAssertion(credential, testChallenge, 'https://example.com')
      ).rejects.toThrow('User handle mismatch')
    })
  })

  describe('Signature verification', () => {
    const testChallenge = 'test-challenge'

    it('should reject invalid signatures', async () => {
      // Mock: credential exists
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'passkey-1',
          user_id: 'test-user',
          credential_id: 'test-credential-id',
          public_key: 'mock-public-key',
          counter: 0,
          device_name: null,
          transports: null,
          created_at: new Date(),
          last_used_at: null,
        }],
      })

      const credential = createMockCredential({ invalidSignature: true, challenge: testChallenge })
      await expect(
        service.verifyAssertion(credential, testChallenge, 'https://example.com')
      ).rejects.toThrow('Signature verification failed')
    })
  })

  describe('RP ID Hash verification', () => {
    const testChallenge = 'test-challenge'

    it('should reject when rpIdHash does not match expected origin', async () => {
      const authData = createMockAuthenticatorData({ rpId: 'attacker.com' })
      await expect(
        service.verifyAssertion(
          createMockCredential({ authData, challenge: testChallenge }),
          testChallenge,
          'https://legitimate.com'
        )
      ).rejects.toThrow('RP ID mismatch')
    })
  })
})
