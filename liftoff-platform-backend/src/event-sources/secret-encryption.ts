// AES-256-GCM envelope for event-source signing secrets.
//
// The signing secret is the credential that authenticates inbound POSTs to
// /api/events/custom/:token. Storing it as plaintext TEXT in the database
// makes a database exfiltration equivalent to a full webhook compromise.
// This module wraps plaintext secrets with AES-256-GCM using a master key
// loaded from Secret Manager at process start.
//
// Storage layout (BYTEA in event_sources.signing_secret_ciphertext):
//
//   [version:1B][iv:12B][authTag:16B][ciphertext:Nbytes]
//
// version=0x01 reserves a byte for future algorithm changes (e.g. an HSM
// envelope). Decryption rejects unknown versions hard, so a rotation can
// re-encrypt rows lazily.
//
// Key management:
//   - The 32-byte master key lives in Secret Manager as
//     `event-source-encryption-key`, hydrated into env var
//     `EVENT_SOURCE_ENCRYPTION_KEY` at startup (hex-encoded, 64 chars).
//   - Rotation is out-of-scope for this module; if the key ever needs
//     rotating, write a one-shot script that decrypts under the old key and
//     re-encrypts under the new key. The version prefix supports a future
//     multi-key world without a schema change.
//   - In dev/test, set the env var directly (any 64-char hex). The module
//     refuses to operate when the key isn't set, rather than falling back
//     to plaintext.

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // GCM standard
const TAG_LENGTH = 16;       // GCM standard
const VERSION_BYTE = 0x01;
const KEY_HEX_LENGTH = 64;   // 32 bytes hex-encoded

export class EventSourceKeyMissingError extends Error {
  constructor() {
    super(
      'EVENT_SOURCE_ENCRYPTION_KEY is not configured. Add the `event-source-encryption-key` ' +
      'secret to Secret Manager (32 random bytes hex-encoded) and to the SECRET_MANIFEST in ' +
      'src/infrastructure/secrets.ts.',
    );
    this.name = 'EventSourceKeyMissingError';
  }
}

export class EventSourceCiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventSourceCiphertextError';
  }
}

function loadKey(): Buffer {
  const hex = process.env.EVENT_SOURCE_ENCRYPTION_KEY;
  if (!hex) throw new EventSourceKeyMissingError();
  if (hex.length !== KEY_HEX_LENGTH || !/^[0-9a-f]+$/i.test(hex)) {
    throw new EventSourceCiphertextError(
      `EVENT_SOURCE_ENCRYPTION_KEY must be ${KEY_HEX_LENGTH} hex chars (32 bytes); got ${hex.length}`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Encrypt a plaintext signing secret. Returns a Buffer suitable for BYTEA storage. */
export function encryptSecret(plaintext: string): Buffer {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([VERSION_BYTE]),
    iv,
    authTag,
    ciphertext,
  ]);
}

/** Decrypt a stored ciphertext buffer back to the plaintext signing secret. */
export function decryptSecret(envelope: Buffer): string {
  if (envelope.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new EventSourceCiphertextError('ciphertext too short');
  }
  const version = envelope[0];
  if (version !== VERSION_BYTE) {
    throw new EventSourceCiphertextError(`unsupported ciphertext version: ${version}`);
  }
  const iv = envelope.slice(1, 1 + IV_LENGTH);
  const authTag = envelope.slice(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = envelope.slice(1 + IV_LENGTH + TAG_LENGTH);

  const key = loadKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    throw new EventSourceCiphertextError(
      `decryption failed (likely tampered ciphertext or wrong key): ${(err as Error).message}`,
    );
  }
}

/** Test helper: pre-set a deterministic key for the duration of a test. */
export function _setKeyForTesting(hex: string | undefined): void {
  if (hex === undefined) delete process.env.EVENT_SOURCE_ENCRYPTION_KEY;
  else process.env.EVENT_SOURCE_ENCRYPTION_KEY = hex;
}
