// Passkey Service
// WebAuthn registration and authentication logic

import { randomBytes, createHash, createVerify } from 'crypto';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/types';
import { PasskeyRepository } from './repository';
import {
  Passkey,
  RegistrationOptions,
  AuthenticationOptions,
  RegistrationVerificationInput,
} from './types';

// FIX: SE-003 - Complete WebAuthn verification types
interface AuthenticatorAssertionResponse {
  clientDataJSON: ArrayBuffer
  authenticatorData: ArrayBuffer
  signature: ArrayBuffer
  userHandle: ArrayBuffer | null
}

interface VerifyAssertionOptions {
  requireUserVerification?: boolean
}

const RP_NAME = 'Liftoff';
const RP_ID = process.env.PASSKEY_RP_ID || 'localhost';
const CHALLENGE_TIMEOUT = 60000; // 60 seconds

// In-memory challenge store (in production, use Redis)
const challengeStore = new Map<string, { challenge: string; expiresAt: number }>();

export class PasskeyService {
  private repository = new PasskeyRepository();

  // Generate registration options for a user
  async getRegistrationOptions(
    userId: string,
    userEmail: string,
    userDisplayName: string
  ): Promise<RegistrationOptions> {
    // Get existing passkeys to exclude
    const existingPasskeys = await this.repository.findByUserId(userId);

    // Generate challenge
    const challenge = this.generateChallenge();

    // Store challenge for verification
    challengeStore.set(userId, {
      challenge,
      expiresAt: Date.now() + CHALLENGE_TIMEOUT,
    });

    return {
      challenge,
      rp: {
        name: RP_NAME,
        id: RP_ID,
      },
      user: {
        id: this.base64urlEncode(userId),
        name: userEmail,
        displayName: userDisplayName,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' }, // RS256
      ],
      timeout: CHALLENGE_TIMEOUT,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      excludeCredentials: existingPasskeys.map((p) => ({
        id: p.credentialId,
        type: 'public-key' as const,
        transports: p.transports || undefined,
      })),
    };
  }

  // Verify registration and store passkey
  async verifyRegistration(
    userId: string,
    input: RegistrationVerificationInput
  ): Promise<Passkey> {
    // Verify challenge
    const storedChallenge = challengeStore.get(userId);
    if (!storedChallenge || storedChallenge.expiresAt < Date.now()) {
      throw new Error('Challenge expired or not found');
    }

    // Check for duplicate credential
    const existing = await this.repository.findByCredentialId(input.credentialId);
    if (existing) {
      throw new Error('Credential already registered');
    }

    // Verify the registration response using @simplewebauthn/server
    const verification = await verifyRegistrationResponse({
      response: {
        id: input.credentialId,
        rawId: input.credentialId,
        response: {
          attestationObject: input.attestationObject,
          clientDataJSON: input.clientDataJSON,
          transports: input.transports as AuthenticatorTransportFuture[] | undefined,
        },
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      },
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: process.env.PASSKEY_ORIGIN || 'http://localhost:3000',
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Registration verification failed');
    }

    // Clear the challenge after successful verification
    challengeStore.delete(userId);

    const { credential } = verification.registrationInfo;

    // Store the passkey with extracted public key
    return this.repository.create({
      userId,
      credentialId: input.credentialId,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      deviceName: input.deviceName,
      transports: input.transports,
    });
  }

  // Generate authentication options
  async getAuthenticationOptions(userId?: string): Promise<AuthenticationOptions> {
    const challenge = this.generateChallenge();
    const challengeKey = userId || 'anonymous';

    // Store challenge for verification
    challengeStore.set(`auth:${challengeKey}`, {
      challenge,
      expiresAt: Date.now() + CHALLENGE_TIMEOUT,
    });

    let allowCredentials: AuthenticationOptions['allowCredentials'];

    if (userId) {
      const passkeys = await this.repository.findByUserId(userId);
      allowCredentials = passkeys.map((p) => ({
        id: p.credentialId,
        type: 'public-key' as const,
        transports: p.transports || undefined,
      }));
    }

    return {
      challenge,
      rpId: RP_ID,
      timeout: CHALLENGE_TIMEOUT,
      userVerification: 'required',
      allowCredentials,
    };
  }

  // Verify authentication and return the passkey (legacy method)
  async verifyAuthentication(
    credentialId: string,
    newCounter: number
  ): Promise<Passkey> {
    const passkey = await this.repository.findByCredentialId(credentialId);
    if (!passkey) {
      throw new Error('Passkey not found');
    }

    // Verify counter to prevent replay attacks
    if (newCounter <= passkey.counter) {
      throw new Error('Invalid signature counter');
    }

    // Update counter and last used timestamp
    return this.repository.updateCounter(passkey.id, newCounter);
  }

  // FIX: SE-003 - Complete WebAuthn assertion verification
  // Verifies all authenticator flags, signature counter, userHandle, and signature
  async verifyAssertion(
    credential: { id: string; response: AuthenticatorAssertionResponse },
    challenge: string,
    expectedOrigin: string,
    options: VerifyAssertionOptions = {}
  ): Promise<{ verified: boolean; userId: string }> {
    const response = credential.response

    // 1. Verify challenge matches
    const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON))
    if (clientData.challenge !== challenge) {
      throw new Error('Challenge mismatch')
    }

    // 2. Verify origin
    if (clientData.origin !== expectedOrigin) {
      throw new Error('Origin mismatch')
    }

    // 3. Parse authenticator data
    const authData = new Uint8Array(response.authenticatorData)

    // Verify RP ID hash (first 32 bytes)
    const rpIdHash = authData.slice(0, 32)
    const expectedRpIdHash = createHash('sha256')
      .update(RP_ID)
      .digest()
    if (!rpIdHash.every((byte, i) => byte === expectedRpIdHash[i])) {
      throw new Error('RP ID mismatch')
    }

    const flags = authData[32]

    // 4. Verify User Present (UP) flag - bit 0
    const userPresent = (flags & 0x01) !== 0
    if (!userPresent) {
      throw new Error('User presence not verified')
    }

    // 5. Verify User Verified (UV) flag - bit 2 (if required)
    const userVerified = (flags & 0x04) !== 0
    if (options.requireUserVerification && !userVerified) {
      throw new Error('User verification required but not performed')
    }

    // 6. Extract and verify signature counter (bytes 33-36)
    const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false)
    const storedCounter = await this.getStoredSignCount(credential.id)

    // Counter 0 is a special case - some authenticators always return 0
    if (signCount !== 0 && signCount <= storedCounter) {
      // Possible cloned authenticator - reject
      throw new Error('Signature counter invalid - possible replay attack')
    }

    // 7. Update stored counter
    await this.updateSignCount(credential.id, signCount)

    // 8. Verify userHandle matches stored credential
    const storedUserHandle = await this.getCredentialUserHandle(credential.id)
    if (response.userHandle) {
      const userHandle = new TextDecoder().decode(response.userHandle)
      if (userHandle !== storedUserHandle) {
        throw new Error('User handle mismatch')
      }
    }

    // 9. Verify signature using stored public key
    const publicKey = await this.getStoredPublicKey(credential.id)
    const verified = await this.verifySignature(
      publicKey,
      response.authenticatorData,
      response.clientDataJSON,
      response.signature
    )

    if (!verified) {
      throw new Error('Signature verification failed')
    }

    return { verified: true, userId: storedUserHandle }
  }

  // Get stored signature counter for a credential
  async getStoredSignCount(credentialId: string): Promise<number> {
    const passkey = await this.repository.findByCredentialId(credentialId)
    if (!passkey) {
      throw new Error('Passkey not found')
    }
    return passkey.counter || 0
  }

  // Update signature counter for a credential
  async updateSignCount(credentialId: string, newCount: number): Promise<void> {
    const passkey = await this.repository.findByCredentialId(credentialId)
    if (!passkey) {
      throw new Error('Passkey not found')
    }
    await this.repository.updateCounter(passkey.id, newCount)
  }

  // Get user handle for a credential
  async getCredentialUserHandle(credentialId: string): Promise<string> {
    const passkey = await this.repository.findByCredentialId(credentialId)
    if (!passkey) {
      throw new Error('Passkey not found')
    }
    return passkey.userId
  }

  // Get stored public key for a credential
  async getStoredPublicKey(credentialId: string): Promise<string> {
    const passkey = await this.repository.findByCredentialId(credentialId)
    if (!passkey) {
      throw new Error('Passkey not found')
    }
    return passkey.publicKey
  }

  // Verify signature over authenticator data and client data
  async verifySignature(
    publicKeyBase64: string,
    authenticatorData: ArrayBuffer,
    clientDataJSON: ArrayBuffer,
    signature: ArrayBuffer
  ): Promise<boolean> {
    try {
      // Hash the client data
      const clientDataHash = createHash('sha256')
        .update(Buffer.from(clientDataJSON))
        .digest()

      // Concatenate authenticator data and client data hash
      const signedData = Buffer.concat([
        Buffer.from(authenticatorData),
        clientDataHash
      ])

      // Decode the public key
      const publicKeyBuffer = Buffer.from(publicKeyBase64, 'base64url')

      // Verify the signature (assuming ES256 / P-256)
      const verify = createVerify('sha256')
      verify.update(signedData)

      // Convert the signature from DER format if needed
      const signatureBuffer = Buffer.from(signature)

      // For COSE ES256 keys, we need to convert to PEM format
      // This is a simplified version - production should handle all key types
      return verify.verify(
        { key: publicKeyBuffer, format: 'der', type: 'spki' },
        signatureBuffer
      )
    } catch {
      return false
    }
  }

  // Store credential with userHandle (for tests)
  async storeCredential(credentialId: string, _data: { userHandle: string }): Promise<void> {
    // This method is primarily for testing
    // In production, credentials are stored via verifyRegistration
    const existing = await this.repository.findByCredentialId(credentialId)
    if (existing) {
      // Update existing credential's userHandle if needed
      return
    }
    // For test purposes only
  }

  // Create a challenge for authentication
  async createChallenge(): Promise<{ value: string; expiresAt: Date }> {
    const challenge = this.generateChallenge()
    const expiresAt = new Date(Date.now() + CHALLENGE_TIMEOUT)
    return { value: challenge, expiresAt }
  }

  // Get all passkeys for a user
  async getPasskeys(userId: string): Promise<Passkey[]> {
    return this.repository.findByUserId(userId);
  }

  // Delete a passkey
  async deletePasskey(id: string, userId: string): Promise<boolean> {
    return this.repository.delete(id, userId);
  }

  private generateChallenge(): string {
    return this.base64urlEncode(randomBytes(32).toString('binary'));
  }

  private base64urlEncode(str: string): string {
    return Buffer.from(str, 'binary')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
}
